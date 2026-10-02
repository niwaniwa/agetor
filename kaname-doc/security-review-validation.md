# Agetor セキュリティレビュー検証結果

検証日: 2026-09-10  
対象: 同一ソースツリーに対する独立した 2 本のレビュー  
- Review A（実装中心）: `fable-sec-check.md`  
- Review B（敵対的脅威モデル）: `codex-sec-check.md`

検証方法: レビューを仮説として扱い、該当実装を静的に追跡した。リポジトリコードの実行、依存関係のインストール、スクリプト実行、ソース改変、外部通信は行っていない。動的な攻撃再現はしていない。

---

## Final Verdict

### 1. 個人の開発リポジトリ

**条件付きで適している。**

自分で書いたコード、自分で管理するクローン、自分のワークステーションという前提なら、アプリ実装の堅牢性（localhost bind、起動ごとの乱数トークン、argv 配列、Issue 本文の untrusted 警告、Markdown XSS 対策、worktree 削除の閉じ込め）は個人用途として足りる。

ただし git worktree はサンドボックスではない。エージェントは原則として同一 OS ユーザー権限で動き、`~/.ssh`、クラウドトークン、`~/.agetor/github-tokens.json`、他ハーネスの資格情報に届く。これを理解したうえで、信頼できる自分のリポジトリにだけタスクを向けるなら個人利用は妥当である。

### 2. 非公開の会社リポジトリ

**通常の開発アカウントのままでは推奨しない。専用境界がある場合のみ許容。**

社内リポジトリ自体が信頼できても、Agetor はタスク単位の資格情報分離もプロセス分離も持たない。1 本のタスク（またはプロンプトインジェクションに成功したエージェント）が、保存済み Git ホストトークン、他タスク、ホストシェル、同一 UID の社内シークレットへ横展開できる。会社の PAT / SSH / クラウド資格情報を載せた日常ワークステーションで動かすのは、Review B の結論どおり不適切である。

専用 Unix ユーザー、またはそれ以上（VM）でホスト資格情報を渡さない運用なら、信頼済み社内リポジトリに限って使える。

### 3. 未信頼の第三者リポジトリ

**現時点では不適。**

通常の `git clone` だけでも、Claude タスク＋デフォルトの worktree 分離で **V-01（設定 symlink による秘密コピー）** が成立し得る。加えて Claude のフォルダ信頼ダイアログは自動承認され（V-02）、Git 呼び出しに hook / textconv / fsmonitor の無効化がない（V-03）。プロンプトインジェクションが成功すれば、そのままユーザー権限の任意実行になる。未信頼ツリーを「worktree に入れたから安全」と考える運用は誤りである。

---

## Confirmed Vulnerabilities

### V-01 — HIGH — リポジトリ内 symlink が Agetor の設定マージで秘密を worktree へコピーする

- **対応するレビュー**: Review B F-03。Review A は未指摘。
- **分類**: CONFIRMED VULNERABILITY
- **Severity**: HIGH
- **Source locations**:
  - `src/bun/hook-installer.ts` — `applyAgetorSettings()`（146 行付近）、`readFile(settingsFile)`（158）、`writeJsonAtomic()`（264）
  - `src/bun/claude-tmux.ts` — `spawnClaudeViaTmux()` が `ensureInstalledForCwd(opts.cwd)` を tmux 起動前に呼ぶ（6624）
  - `src/bun/core-creds.ts` — `agetor-core.json`（`dataDir` 直下、0600）
  - `src/bun/github-tokens.ts` — `github-tokens.json`（同位置）
  - `src/bun/orchestrator.ts` — `isolation` のデフォルトは `"worktree"`（4754）
  - `src/bun/worktree.ts` — worktree は `dataDir/worktrees/<taskId>/`
- **Verified data flow**:
  1. 攻撃者は追跡対象として `.claude/settings.local.json` → `../../../agetor-core.json`（または `../../../github-tokens.json`）という相対 symlink をコミットする。通常の `git clone` でも symlink は作業ツリーに復元される（`.git/config` や hook は転送されない。V-03 より前提が弱い）。
  2. 被害者がそのクローンを workdir にし、Claude タスクを開始する。デフォルト isolation は worktree。
  3. `prepareWorkdir()` が `<dataDir>/worktrees/<taskId>/` を切る。相対パス `../../../` は常に `dataDir` に届く（ユーザー名の推測は不要）。
  4. `ensureInstalledForCwd` は cwd が `dataDir/worktrees/` 配下なら `ensureInstalled()` を使う。`readFile(settingsFile)` は symlink を辿り、稼働中なら存在する `agetor-core.json` を読む。
  5. JSON としてパースできたオブジェクト（`token` / `port` 等）が `settings` に残る。
  6. `writeJsonAtomic` は隣の tempfile に書き、POSIX `rename` で **symlink 自体を通常ファイルに置き換える**（リンク先の秘密ファイルは上書きされない）。結果、管理トークン（および存在すれば Git ホストトークン）のコピーが **未信頼 worktree 内の通常ファイル** になる。mode 指定はなく、0600 でもない。
  7. この書き込みはエージェントのプロジェクトコマンドより前に起きる。モデルを欺く必要はない。
- **Attacker prerequisites**:
  - 被害者がそのリポジトリで **Claude** タスクを開始する（hook-installer は claude-tmux 専用）。
  - isolation が worktree（デフォルト）。
  - OS が git symlink を作成する（本アプリは macOS 前提。`core.symlinks=true`）。
  - コピー対象ファイルが存在する（コアは API bind 後に `agetor-core.json` を書くので、稼働中は満たしやすい）。
- **Impact**:
  - 起動ごとの API ベアラが未信頼ツリーに落ち、同一 UID のエージェントや誤コミット／誤 push で漏えいする。
  - トークン取得後は V-AR1 の管理面（全タスク、ターミナル PTY、GitHub merge 等）へ接続できる。
  - `github-tokens.json` を狙えば長期 PAT のコピーになる。
- **Recommended fix**:
  - 設定パスの最終要素と親を `lstat` し、symlink なら拒否する（可能なら `O_NOFOLLOW` / descriptor 基準）。
  - リポジトリ由来の JSON を、Agetor の秘密ファイルと同じディレクトリへ相対解決できる状態で読まない。
  - 可能なら `.claude/settings.local.json` を worktree 内ではなく Agetor 所有の別領域に生成する。
  - 書き込みは 0600。未知キーを秘密ファイルからマージしない（読み取り対象が Agetor 設定スキーマであることを検証する）。
- **Confidence**: 高（データフローはソース上確定。動的再現は未実施）

### V-02 — HIGH — Claude のリポジトリ信頼確認を Agetor が自動承認する

- **対応するレビュー**: Review B F-02。Review A は未指摘。Gemini の `--skip-trust` も同型。
- **分類**: CONFIRMED VULNERABILITY（意図した UX だが、ベンダーの信頼境界をコードが外している）
- **Severity**: HIGH（未信頼リポジトリ利用時）。信頼済み自分のリポジトリだけなら実害は小さい。
- **Source locations**:
  - `src/bun/claude-tmux.ts` — `STARTUP_CONSENT_DIALOGS`（5034）、`matchStartupConsentDialog`（5083）、`confirmStartupDialog`（5127）、boot poller（6916–6934）が `tmux send-keys` で肯定選択肢＋Enter
  - 対象ダイアログは Bypass Permissions 警告と **「Yes, I trust this folder」**
  - `src/bun/agents.ts` — Gemini は mode に関係なく `--skip-trust`（638）。コメントどおり headless が未信頼ディレクトリで exit 55 になるための措置
- **Verified data flow**:
  1. デフォルト worktree は毎回新しいパスなので、Claude の workspace trust が発火する（コードコメントが明記）。
  2. マーカー＋番号付き選択肢＋肯定ラベルが揃うと、ユーザー操作なしで承認キーが送られる。
  3. 未知ダイアログはカード化する分岐があるが、trust-folder / bypass は自動処理される。
- **Attacker prerequisites**: 被害者がそのディレクトリで Claude（または Gemini）タスクを開始する。通常 clone で足りる。
- **Impact**:
  - Claude Code が「このフォルダを信頼するか」で止めていた hook / プロジェクト MCP / SessionStart 等のゲートが消える。
  - 追跡対象の `.claude/settings.json` や hook は clone で運ばれる。V-03 と違い **`.git` の支配は不要**。
  - 具体的な hook 発火タイミングは Claude CLI の版に依存する。本検証は CLI を実行していないため、「無条件の RCE」とは断定しない。自動承認そのものはソース上確定。
- **Recommended fix**:
  - trust-folder は自動承認しない。ユーザー確認、または「この workdir を信頼する」を Agetor 側の明示設定にする。
  - 未信頼用途ではホストの `~/.claude` / MCP / 資格情報を渡さない隔離実行にする。
  - Gemini の `--skip-trust` も、隔離なしでは同等リスクとして扱う。
- **Confidence**: 自動承認は高。hook 実行による RCE は中（外部 CLI の挙動依存）

### V-03 — MEDIUM — Git 呼び出しに hook / 補助プログラムの無効化がない

- **対応するレビュー**: Review A AGT-M1（MEDIUM）、Review B F-01（HIGH）。ソースは双方の「git が argv 配列でも hook は別経路」という点を支持する。重要度は Review A に近い。
- **分類**: CONFIRMED VULNERABILITY
- **Severity**: MEDIUM
- **Source locations**:
  - `src/bun/worktree.ts` — `git()`（36）は `Bun.spawn(["git", ...args], { cwd })` のみ。`env` 上書きなし。`GIT_CONFIG_NOSYSTEM` / `GIT_TERMINAL_PROMPT` / `-c core.hooksPath=/dev/null` / `--no-ext-diff` はリポジトリ全体を grep しても存在しない。
  - `prepareWorkdir()` の `git worktree add`（846–849）および reuse 時の `git checkout`（802）
  - `hasUncommittedChanges()` の `git status --porcelain`（103）
  - `getTaskDiff()` の `git diff --no-color`（969）
  - `src/bun/project-files.ts` の同型 `git()`（84）
  - `src/bun/github.ts` の `run()`（543）も env ハードニングなし
- **Verified data flow**:
  - Git は `worktree add` / `checkout` 後に `post-checkout` を走らせる。`core.hooksPath`、`core.fsmonitor`、`diff.external`、textconv はリポジトリの `.git/config` から解釈される。
  - argv 配列はシェルインジェクションを防ぐが、git 自身の設定実行は防がない。
- **Attacker prerequisites**:
  - **通常の `git clone` では `.git/config` と `.git/hooks` は転送されない。** Review B 自身がこれを反証として書いている。ソースも Agetor 内 clone 実装を持たない。
  - 成立するのは、攻撃者が `.git` ごと渡した作業コピー（zip / `cp -r`）、既に汚染されたローカル `.git`、または被害者がそのメタデータを受け入れる場合。
  - そのうえで被害者がタスク開始、ステータス表示、差分表示などを行う。
- **Impact**: ユーザー権限でのコード実行。エージェント起動前に起き得る。root 昇格ではない。
- **Recommended fix**: 読み取り系は `GIT_CONFIG_NOSYSTEM=1`、`GIT_TERMINAL_PROMPT=0`、`-c core.hooksPath=/dev/null`、`-c core.fsmonitor=false`、`--no-ext-diff`。checkout / worktree add も可能な範囲で hook 無効化。未信頼 Git の解析自体を隔離環境へ移す。
- **Confidence**: 機構は高。通常 clone 経由の現実的悪用は中（社会工学で `.git` 付き配布が要る）

### V-04 — MEDIUM — 開発チャネルが未認証の localhost:5173 を UI として採用し、管理トークンを注入する

- **対応するレビュー**: Review B F-05。Review A は未指摘。
- **分類**: CONFIRMED VULNERABILITY（**dev チャネル限定**。stable の bundled `views://` では非成立）
- **Severity**: MEDIUM
- **Source locations**:
  - `src/bun/index.ts` — `getMainViewUrl()`（99）。`channel === "dev"` なら `fetch(http://localhost:5173, { method: "HEAD" })` が例外を投げないだけでその URL を返す。ステータス検証も、Vite 固有の印もない。`fetch` は 404 でも throw しない。
  - 同ファイル — `window.__AGETOR` に `token: API_TOKEN` を preload（534）、HTTP URL なら URL hash にもトークン（564）
  - `src/bun/server.ts` — `ALLOWED_ORIGINS` に `http://localhost:5173`（563）
  - `vite.config.ts` — port 5173、`strictPort: true`。host 認証はなし
- **Verified data flow**:
  1. 正規 Vite が未起動、または他者が先に 5173 を占有する。
  2. HEAD がネットワーク的に成功すれば、Agetor はそのオリジンを UI にする。
  3. ネイティブ側が **攻撃者ページの JS 文脈へ** 管理トークンを入れる。
  4. 以降は管理 API 全権（V-AR1）。
- **Attacker prerequisites**:
  - バイナリの updater channel が `dev`。
  - 攻撃者が同一マシンで `localhost:5173` を listen できる。
  - **同一 UID のマルウェアなら `agetor-core.json`（0600）を直接読める**ので、この経路の独自価値は主に **別 UID**（共有マシン）である。個人ラップトップでは重要度が下がる。
- **Impact**: 開発ビルドで、別ユーザーのローカルプロセスが被害者ユーザー権限の API を握れる。
- **Recommended fix**: 自分が起動した dev server との認証済みハンドオフだけを UI にする。応答があるだけでは採用しない。外部オリジンへ全体管理トークンを渡さない。
- **Confidence**: 高（dev 限定であることもソース上明確）

### V-05 — LOW — 未信頼 Markdown のリモート画像によるトラッキング

- **対応するレビュー**: Review A AGT-L1。Review B はローカル画像の自動表示を棄却した一方、リモート `<img>` は未評価。
- **分類**: CONFIRMED VULNERABILITY
- **Severity**: LOW
- **Source locations**:
  - `src/mainview/lib/md-image.ts` — `https?:` は `remote` でパススルー
  - `src/mainview/components/kanban/MdImage.tsx` — `source.kind === "remote"` で `<img src={source.url}>`（154–175）。`allowLocal: false` はローカルファイルだけを封じ、リモートは GitHubDialog でも描画する（ファイル先頭コメント）
  - `src/mainview/index.html` — CSP なし（charset / viewport / テーマ用 script）
- **Verified data flow**: Issue / PR 本文やエージェント出力の `![](https://attacker/pixel.png)` → webview が攻撃者へリクエスト。トークンは hash にあり Referer には乗らない。
- **Attacker prerequisites**: 被害者がその Markdown を UI で開く（Issue 閲覧、トランスクリプト表示）。
- **Impact**: IP・タイミング等のプライバシー。資格情報窃取には至らない。
- **Recommended fix**: webview CSP（`img-src` 制限）、または未信頼スコープではリモート画像をチップにする。
- **Confidence**: 高

---

## Architectural Risks

Agetor の中核リスクは「実装バグで権限が上がる」ことより、「エージェント＝その OS ユーザー」という設計である。CLAUDE.md もサンドボックスがないと明記している。これは脆弱性一覧に混ぜると過大評価になるため、ここに分離する。

### 隔離の区別（worktree ≠ セキュリティ境界）

| 種類 | Agetor の現状 | 意味 |
|------|----------------|------|
| **git worktree 隔離** | デフォルトで `~/.agetor/worktrees/<taskId>/` にブランチを切る | ソースツリーと作業コピーを分ける。**セキュリティ境界ではない。** 同一 `.git`（linked worktree）、同一 UID、同一 HOME。 |
| **プロセス隔離** | なし。`Bun.spawn` / tmux 子プロセス。fx はパイプ付き同一ユーザープロセス | エージェントは Agetor と同じユーザー。PID 名前空間も分かれていない。 |
| **ファイルシステム隔離** | なし。Codex `auto` は通常 `workspace-write` だが、linked worktree では `gitWritableRoots()` が外部 `.git` を検出し **`--sandbox danger-full-access -c approval_policy=never`** にエスカレート（`src/bun/agents.ts` 748–777、`worktree.ts` 361）。Cursor `auto` は `--force --sandbox disabled`。Claude `auto` は `--dangerously-skip-permissions`。Gemini はサンドボックスなし＋`--skip-trust`。fx 0.0.5+ はコマンドサンドボックス廃止 | デフォルト isolation=worktree は、Codex が持っていた数少ない製品サンドボックスを **Agetor が外す**。 |
| **資格情報隔離** | なし。エージェントはユーザーの HOME、SSH agent、`gh auth`、`GITHUB_TOKEN`、`~/.agetor/github-tokens.json`、他ハーネスの auth に届く。Claude へ `AGETOR_API_TOKEN` を env 注入する旧処理は削除済み（claude-tmux.ts 6632）が、同一 UID なら `agetor-core.json` を読める。`githubToken()` は store → env → `gh auth token`（github.ts 860） | タスク別トークンも、ホスト秘密のブローカーもない。 |
| **ネットワーク隔離** | なし。loopback の管理 API（127.0.0.1、デフォルト 4317）に同一 UID から届く。SSH agent socket、任意の外部ホストも同様 | トークンを知れば CSRF なしで管理面を操作できる。 |

### V-AR1 — 侵害された 1 タスクから管理面・全タスク・接続アカウントへ横展開できる

- **対応**: Review B F-04（HIGH の実装脆弱性として報告）。Review A は「同一 UID なので脆弱性ではない」と境界節に置いた。
- **分類**: ARCHITECTURAL RISK（実装欠陥というより設計）
- **ソースが支持する解釈**: Review A。
  - `isAuthorized()`（server.ts 350）は全体で単一の `API_TOKEN`。タスク capability はない。
  - `/tasks/:id/terminals` POST（5361）→ `terminals.ts` が `{ ...process.env }` でログインシェル PTY（178）。
  - `/github/pull-merge`（1963）はトークン＋リクエスト値のみ。
  - ただし **同一 UID の unsandboxed エージェントは、API を使わなくても** ホストコマンド・ファイル読み・他 worktree 書き込みができる。API は構造化された便利な制御面を足す。
  - 例外: Codex が本当に `workspace-write` のままなら cwd 外の `agetor-core.json` は読めない可能性がある。しかしデフォルト worktree では Agetor が full-access に上げるため、その例外は常用パスでは消える。
- **Impact**: 日常構成では「悪意あるエージェント ≈ そのユーザーの権限全体」。root 自動取得ではない。Keychain ACL まではソースから無条件取得とは言えない。

### V-AR2 — dataDir 作成が 0700 ではない

- Review A の INFO。`src/bun/db.ts` 46: `mkdirSync(DATA_DIR, { recursive: true })` に mode なし。`agetor-core.json` / トークン store は 0600 だが、ディレクトリや SQLite・ログは umask 任せ。
- マルチユーザー機でホームが探索可能なときの横取り・列挙リスク。同一 UID エージェントには無効。

### V-AR3 — CLI installer の checksum が同一配布元

- Review B F-06 を HIGH 脆弱性として報告。Review A は sha256 必須を防御として肯定的に書いた。
- **分類**: ARCHITECTURAL RISK / サプライチェーンの既知限界。**実装脆弱性としては棄却。**
- `scripts/install.sh` は HTTPS、TLS 1.2、checksum 必須。欠落・不一致は拒否する。期待値も同じ GitHub Releases から取るため、リリース資産の同時改ざんは検出できない。これは curl|sh インストーラ一般の性質であり、Agetor 固有のロジックバグではない。
- 署名者 identity の固定検証は防御強化として妥当。

### V-AR4 — ビルドホスト PATH の tmux 取り込み

- Review B のサプライチェーン節。`scripts/fetch-tmux.ts` は Homebrew の tmux / dylib を再配置・再署名する。信頼根にビルドマシンが入る。アプリ自動更新は Electrobun `Updater` 委譲（`src/bun/updater.ts`）で、本リポジトリだけでは署名検証の完全性を断定できない。

---

## Defense-in-Depth Improvements

実装事実だが、単独では実用的な攻撃にならない、または既存の同一 UID 権限に対する追加トリガーに過ぎないもの。

| ID | 内容 | 理由 |
|----|------|------|
| D-01 | `isAuthorized` の非定数時間 `===` と、全ルートでの `?token=` 受理（Review A AGT-L3） | 32 バイト乱数を HTTP 越しにタイミング攻撃するのは非現実的。EventSource 用の query は必要。ログに生トークンを書く実装は見当たらない。`timingSafeEqual` と query の限定は良い硬化。 |
| D-02 | `/open-path` が拡張子・封じ込めなしで `native.openPath`（Review A AGT-L2、server.ts 3962） | ユーザーがタイルの Open を押す必要あり。エージェントは既に同一 UID で任意実行できる。確認ダイアログは UX 硬化。 |
| D-03 | `/files/preview` が `statSync` で symlink を辿る。`isImagePath` はパス文字列の拡張子のみ。`isSafeRelPath` も symlink 非対応とコメント明記（worktree.ts 1058） | トークン所持者は任意画像パスを読める設計。同一 UID なら秘密ファイルも直接読める。lstat + realpath 閉じ込めは hardening。 |
| D-04 | CORS が不許可 Origin に `Access-Control-Allow-Origin: null` かつ credentials true（server.ts 339–347） | 認証は Cookie ではなく Bearer。サイトはトークンを作れない。エコーをやめるのは hardening。 |
| D-05 | plan approve の `mkdirSync` + `Bun.write` が `.cursor/plans` の symlink を辿り得る（server.ts 4830）。ファイル名は `planSlug` でサニタイズ済み | 書き込み内容は承認済み plan Markdown。任意バイト上書きではない。親 symlink 拒否は F-03 と同系統の hardening。 |
| D-06 | Codex worktree での sandbox 解除 | 機能上の git commit のためだが、唯一の製品 FS 境界を常用パスで捨てる。writable_roots 等の狭い許可の方が防御になる。 |

---

## Disagreements Between Reviewers

ソースが支持する側を「判定」に書いた。

| 論点 | Review A | Review B | ソースの判定 |
|------|----------|----------|----------------|
| 全体 verdict | 信頼できるリポジトリなら条件付きで可 | 追加隔離なしでは日常アカウントで動かすな | **用途で分岐。** 個人の自分の repo は A に近い。未信頼第三者は B。会社は B 寄りの条件付き。 |
| git hook 実行（F-01 / AGT-M1） | MEDIUM。`.git` 支配が要る社会工学 | HIGH | **MEDIUM の CONFIRMED。** 機構は双方正しい。通常 clone では `.git` が来ない点は B 自身も書いており、HIGH は過大。 |
| 設定 symlink（F-03） | なし（レビュー本文が途中で乱れて打ち切り） | HIGH 確認済み | **B が正しい。HIGH CONFIRMED。** `readFile` は symlink を辿り、atomic rename はリンクを通常ファイルに置き換える。相対 `../../../` は worktree レイアウトに対して決定的。 |
| trust 自動承認（F-02） | なし | HIGH | **B が正しい。** `confirmStartupDialog` は実在する。Gemini `--skip-trust` も常時付与。 |
| 1 タスクの横展開（F-04） | 脆弱性ではなく信頼境界 | HIGH 実装脆弱性 | **A の分類が正しい（ARCHITECTURAL）。** 単一トークン・terminals・merge API は B の言うとおり実在するが、同一 UID では API なしでも同等の OS 権限がある。B が書いた「追加サンドボックスが読めば止まるがそれは Agetor の保護ではない」も正確。 |
| Codex sandbox 解除 | 境界として言及 | F-04 の根拠の一つ | **両方正しい。** `gitWritableRoots` → `danger-full-access` は意図的。脆弱性 ID より建築リスク。 |
| 開発 UI 5173（F-05） | なし | HIGH、dev 限定 | **経路は B どおり CONFIRMED。** 重要度は **MEDIUM**（dev のみ、独自価値は主にクロス UID）。 |
| install.sh checksum（F-06） | 防御として肯定 | HIGH | **A が近い。** 同一オリジン checksum は限界だが HIGH 実装脆弱性ではない。 |
| リモート画像トラッキング | LOW 確認 | 未掲載（ローカル画像は棄却） | **A が正しい。** `allowLocal: false` は local のみ。remote `<img>` は残る。 |
| `/open-path` | LOW | 番号付き発見なし | **D-02。** ユーザー操作＋既に同一 UID 実行可能。 |
| タイミング比較 | LOW 硬化 | なし | **D-01。** |
| ドライブバイ CSRF でタスク起動 | 無効（トークン） | 無効（トークン） | **合意。正しい。** `API_TOKEN` は 32 バイト乱数（api-config.ts 24）。`/health` のみ未認証で `app:"agetor"` だけ。 |
| Issue 本文のシェルインジェクション | 棄却 | 棄却 | **合意。** prompt は argv / ファイル / paste-buffer。`ISSUE_UNTRUSTED_CONTENT_WARNING` あり。 |
| `@` 参照の symlink 脱出 | 棄却（realpath） | 棄却（F-03 にはその防御が無いと注記） | **合意。** `resolveAtPath` は realpath 閉じ込め（project-files.ts 445）。hook-installer には無い。 |
| worktree `../` 削除 | 棄却 | 棄却 | **合意。** `resolveWorktreeDir`（orchestrator.ts 5614）。 |
| Markdown XSS | 棄却 | 棄却 | **合意。** remarkGfm のみ、rehype-raw なし。 |
| 悪意ある SVG → 同一 origin でトークン | 境界として CSP 言及 | 棄却（preview CSP） | **合意。** `content-security-policy: sandbox; default-src 'none'` + nosniff。 |
| deep link からの実行 | 棄却 | 棄却 | **合意。** `deep-link.ts` は task 表示のみ。 |

Review A 本文は後半が欠け・文字化けしており、INFORMATIONAL 3 件の全文は復元できない。読み取れた範囲（git、CSP、トークン比較、open-path、dataDir 権限、棄却リスト）だけで判定した。

---

## False Positives

レビューが挙げた仮説のうち、ソース上成立しない、または脆弱性として成立しないもの。

- **Issue title / prompt の `$()` による tmux シェルインジェクション**  
  Claude は argv、Codex は引用済み argv＋prompt ファイル、Cursor は `"$@"` と `$(cat file)`。本文がシェルソースになる経路はない。

- **Issue 本文を trusted instruction として無条件採用**  
  `ISSUE_UNTRUSTED_CONTENT_WARNING` がある。OS 境界ではないが「防御なし」は不正確。

- **悪意ある Web サイト単体での CSRF / DNS rebinding によるタスク起動**  
  Cookie セッションではなく Bearer。トークンはサイトが読めない。DNS rebinding はトークンを生まない。

- **不許可 Origin の CORS 拒否が完全防御**  
  これは「防御仮説」として不成立（null エコー）だが、トークン必須のためそれ単体の RCE でもない。

- **Issue のローカル画像パスが `/files/preview` で読まれる**  
  GitHubDialog は `EMPTY_MD_IMAGE_SCOPE`（`allowLocal: false`）。

- **`@file` symlink で cwd 外へ展開**  
  `resolveAtPath` が realpath で拒否。テストあり。

- **orphan worktree id の `../` で任意 `rm -rf`**  
  id に `/` `\` `..` を拒否し、basename 一致を要求。

- **`agetor://` からシェル実行**  
  パースが厳格で、副作用はタスク選択。

- **SSRF で gitlab.com トークンをセルフホストへ送る**  
  `gitlabSelfHostedToken` は cloud トークン / `GITLAB_TOKEN` / glab cloud へフォールバックしない（git-provider.ts）。Review A の棄却を支持。

- **モデル/モード ID の passthrough によるフラグ注入**  
  値は argv 要素。tmux 経路ではシングルクォート。`--dangerously-skip-permissions` のようなフラグにはならない。

- **ハーネス env のコマンドインジェクション**  
  キー検証と値の `sq`。

- **tmux 回答 API への任意キー送信**  
  登録済み choice 以外は 400（server.ts 4496）。

- **別 UID が 0600 の `agetor-core.json` を普通に読む**  
  同一 UID 向け。V-04 はファイルを経由しない。

- **F-06 を HIGH の実装脆弱性とする主張**  
  checksum は機能している。欠けているのは独立した署名根であり、配布元侵害モデルの建築限界。

- **「worktree があるからエージェントはホストに届かない」**  
  どちらのレビューも最終的には否定。worktree は cwd にすぎない。

---

## Insufficient Evidence

- Review B が触れた「親 `.claude` を外へ symlink すると設定 JSON が worktree 外へ書かれる」は、書き込み先追跡としては妥当だが、任意ファイルの任意バイト上書きまではソースから言えない（ファイル名は固定、内容は設定 JSON）。V-01 の付随リスクとして扱う。
- Claude / Gemini が trust 後にどの hook をどのタイミングで実行するかは、本リポジトリ外の CLI 実装に依存。V-02 の RCE 完成形は未検証。
- Electrobun 自動更新の署名検証の有無は、依存実装を実行・読解していないため断定しない。
- Review A の欠落した INFORMATIONAL 全文。
- `bun.lock` の依存パッケージそのものの脆弱性。lock に git/tarball 依存が「無い」ことの全確認は、今回はレビュー記述の追認に留め、全 graph の監査はしていない。

---

## Top Five Remediations

実効的な攻撃半径の縮小が大きい順。

1. **未信頼コードを、ホストの HOME / 資格情報 / 管理 API と共有しない実行境界へ移す**  
   タスクごと（少なくとも「未信頼 workdir」用）の VM が最大。専用 Unix ユーザーでも、秘密と loopback API が見えなければ V-01 / V-AR1 の大半が止まる。worktree や Docker で HOME と Docker socket をマウントしただけでは境界は残らない。

2. **V-01 を直す（symlink 非追従の設定 I/O、秘密をリポジトリツリーに再物質化しない）**  
   通常 clone ＋ Claude という最短経路を閉じる。Agetor が自分で秘密を worktree に置く点は、サンドボックスを後から足しても残る。

3. **管理プレーンとエージェントの分離**  
   `agetor-core.json`・DB・harness・tmux ソケットをエージェントから不可視にする。API をタスク capability に分割する。これがないと、サンドボックスを破った瞬間に全タスクと Git 操作 API が付いてくる。

4. **ベンダー信頼境界を維持する**  
   Claude の trust-folder を自動承認しない。Gemini `--skip-trust` を隔離なしで使わない。Codex の linked worktree で `danger-full-access` にしない（または狭い writable root）。git 呼び出しに hook/fsmonitor/ext-diff 無効化（V-03）。未信頼 clone でも発火する経路（V-02）と、`.git` 汚染時の経路（V-03）の両方を潰す。

5. **開発 UI のトークン注入をやめる（V-04）＋ webview CSP（V-05）**  
   5 番は半径は小さいが、安い。dev チャネルの 5173 無条件採用はクロスユーザーで管理面を渡す。CSP はトラッキングと将来の script 面を削る。

---

## Deployment Recommendation

git worktree 内でコーディングエージェントを動かすことは、サンドボックスではない。

### 通常のワークステーション（日常アカウント）

- **してよいこと**: 自分の個人リポジトリ、自分で内容を把握しているクローン。
- **してはいけないこと**: 未信頼の zip / 見知らぬ GitHub を workdir にする。価値の高い PAT を `github-tokens.json` に載せたまま、第三者 Issue をエージェントに実行させる。
- 開発ビルド（`channel === "dev"`）は 5173 を他プロセスに取られないこと。可能なら bundled view を使う。
- 日常利用でも V-01 修正までは、他人のツリーで Claude を回さない。

### 専用 Unix ユーザー

- 会社リポジトリ向けの最小の現実解。Agetor 専用ユーザーは社内クローンだけを持ち、日常の SSH 鍵・クラウド CLI・ブラウザプロファイルを共有しない。
- そのユーザーの HOME を日常ユーザーから読めないようにする（ホーム 0700、dataDir も 0700）。
- 同一マシンの他ユーザーからの 5173 bind（V-04）を気にするなら、dev チャネルを使わない。
- エージェントが破られても、被害はその UID のリポジトリと、そこに置いたトークンまでに近づく。日常 UID の秘密は残る。

### devcontainer

- コンテナユーザーがホスト HOME、SSH agent socket、`~/.agetor`、Docker socket をマウントすると、境界はほぼ消える。
- 閉じたコンテナ（専用ファイルシステム、ホスト資格情報なし、loopback 管理 API をホストに出さない）なら、未信頼実験の **中程度** の緩和になる。カーネル共有のため、VM より弱い。

### Docker コンテナ

- devcontainer と同じ。`--network=host`、`/var/run/docker.sock`、`-v $HOME:$HOME` は使わない。
- ホストの 4317 に届くネットワークなら、コンテナ内から `agetor-core.json` 相当が読めた時点で管理面も狙える。API をコンテナ外に出さない。
- 未信頼マルウェアを「Docker なら安全」とはしない。

### VM

- 未信頼第三者リポジトリを扱うなら **現状の Agetor に対する唯一の十分な境界**。
- Git の検査・worktree 作成も含めて VM 内で行う（ホスト側で `git status` / `worktree add` すると V-03 がホストで走る）。
- ホスト HOME、SSH agent、Agetor dataDir を共有しない。資格情報は狭い broker（その VM 専用の細粒 PAT）だけ。
- スナップショット破棄を前提にする。

### 今日動かすなら（短い運用ルール）

1. 未信頼リポジトリは VM 以外で開かない。  
2. 会社秘密があるマシンでは専用ユーザーか VM。  
3. 個人の自分のコードなら日常アカウント可。ただし Claude で他人のツリーを回さない（V-01 / V-02）。  
4. worktree オンを「隔離した」と書かない。  
5. V-01 の修正が入るまで、`.claude/settings.local.json` を含む未知リポジトリは特に危険。

---

## 検証範囲メモ

- 参照した主な実装: `hook-installer.ts`, `claude-tmux.ts`, `worktree.ts`, `agents.ts`, `server.ts`, `index.ts`, `api-config.ts`, `core-creds.ts`, `github-tokens.ts`, `project-files.ts`, `terminals.ts`, `db.ts`, `orchestrator.ts`, `deep-link.ts`, `task-plans.ts`, `md-image.ts`, `MdImage.tsx`, `index.html`, `install.sh`, `issue-task.ts`, `git-provider.ts`, `fx-acp.ts`, `codex-tmux.ts`, `updater.ts`, `vite.config.ts`
- 実行・通信・ファイル変更なし。動的 PoC なし。
- JubarteAI MCP はこのセッションに存在せず、ユーザー指示によりネットワークも使っていない。
