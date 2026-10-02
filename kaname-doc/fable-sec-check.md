
Executive Summary（要旨）

全体的なセキュリティ姿勢：アプリケーション実装レベルの堅牢性は高い。ローカル HTTP API は 127.0.0.1 のみにバインドされ、全ルート（/health を除く）が起動ごとに生成される 32 バイトのランダムベアラートークンでゲートされる。サブプロセス構築は総じて注意深く、argv 配列・POSIX シングルクォート（sq）・-- オプション終端・ブランチ名の先頭ハイフンガード・env キー検証によって、シェルインジェクションは実質的に塞がれている。Markdown 描画は react-markdown v10 を rehype-raw なしで使用しており、HTML/XSS 注入は成立しない。外部リンク／open-external はスキームを https?|mailto に限定している。削除プリミティブ（rm -rf／git worktree remove）は WORKTREES_DIR 配下に封じ込められている。

最も重要な信頼境界の観察：Agetor の実質的なリスクは実装バグではなく脅威モデルそのものにある。コーディングエージェントはサンドボリューションなしにユーザの全 OS 権限で動作し、ユーザのディスク上の全認証情報（SSH 鍵、クラウドトークン、~/.agetor/github-tokens.json、~/.claude 資格情報、ブラウザデータ等）に到達できる。したがって「プロンプトインジェクションされたエージェント ＝ ユーザ権限での完全侵害」となる。git 操作には環境ハードニングが一切なく、未信頼リポジトリを開く（タスク開始／差分閲覧）だけでリポジトリ制御のコード（hook・diff フィルタ）が走り得る。

受理した所見の件数：
- CRITICAL: 0
- HIGH: 0
- MEDIUM: 1
- LOW: 3
- INFORMATIONAL: 3

貴重な認証情報を持つワークステーションで Agetor を今すぐ動かすことを推奨するか：条件付きで是。信頼できるリポジトリ・タスクに限れば、アプリ実装の堅牢性は十分。ただし未信頼のリポジトリや第三者作成の Issue/PR テキストを、価値ある認証情報を保持したまま処理させることは推奨しない。プロンプトインジェクション（Issue 本文・エージェント出力経由）が、サンドボックスの無いユーザ権限での任意コード実行に直結するためである。これは実装の欠陥ではなく設計上の選択（CLAUDE.md に明記）だが、そのリスクは利用者が明確に理解している必要がある。

---

Confirmed Findings（確認された所見）

MEDIUM-1: 未信頼リポジトリの git config／hook が、エージェント起動前に実行される

- ID: AGT-M1
- Severity: MEDIUM
- Title: git 実行時の環境ハードニング欠如によるリポジトリ制御コード実行
- File: src/bun/worktree.ts（git() ヘルパ 37行目、prepareWorkdir の worktree add 846–849行目、diff 969行目）、src/bun/project-files.ts（git() 84行目）、src/bun/github.ts（run() 546行目）
- 関数／領域: git(args, cwd) — Bun.spawn(["gstdout, stderr })。env を上書きしないため
  process.env を全継承する。
- 攻撃者の前提: ユーザが、攻撃者が制御する . リ（ダウンロードした zip/tar
  を展開したもの、未信頼ソースから clone し  workdir に指定すること。
- 攻撃者が制御する入力: リポジトリ内の.git/config（core.hooksPath、core.fsmonitor、diff.external、alias.*、core.sshCommand 等）および .git/hooks/*、.gitattributes の textconv/filter ドライバ。
- 脆弱なデータフロー: タスク開始 → startTask → prepareWorkdir → git(["worktree","add",
  ...])（846–849行目）はチェックアウトを伴いる。差分閲覧 → getTaskDiff →git(["diff","--no-color", base])（969行目）は diff.external/textconv を尊重する。いずれも GIT_CONFIG_NOSYSTEM／GIT_TERMINAL_PROMPT=0／-c core.hooksPath=/dev/null／--no-ext-diff／protocol.file.allow の指定が無い。
- 悪用シナリオ: 攻撃者が悪意ある .git/hooks/core.hooksPath）を含むリポジトリを配布。被害者がそれを Agetor のタスク workdir にしてタスクを開始した瞬間、git worktree add がそのフックをユーザ権限で実行する。あるいは悪意ある diff.external を設定したリポジトリの差分を UI で閲覧しただけでコマンドが走る。どちらもユーザが「エージェントを実行する」と意識する前に発火する。
- セキュリティ影響: ユーザ権限での任意コード
- 既存の検証が不十分な理由: git() ヘルパは引数配列で安全にコマンドを構築しているが、git が読み込むリポジトリ内設定・フックには一切の抑制をかけていない。これらは argv 経由ではなく git 自身が自律的に解釈する経路であり、引数エスケープでは防げない。
- 推奨される緩和策: すべての git 呼び出しに   GIT_CONFIG_NOSYSTEM=1を、読み取り専用の差分・列挙には --no-ext-diff と -c core.fsmonitor=false を、worktree/checkout には可能な範囲で -c core.hooksPath=/dev/null を付与する。ローカルクローン系の操作を将来追加するなら -c protocol.file.allow=user を検討。
- Confidence: High（フック実行の機構は確実）／ 現実の悪用可能性は Medium（.git
  付きリポジトリを掴ませる社会工学が前提）。

LOW-1: 未信頼 Markdown 内のリモート画像によるトラッキングピクセル／IP 漏えい

- ID: AGT-L1
- Severity: LOW
- File: src/mainview/components/kanban/MdImage.tsx（source.kind === "remote" 分岐 154–196行目）、src/mainview/lib/md-image.ts（classifyMdImageSrc）、webview に CSP なし（src/mainview/index.html は
  charset/viewport のみ）。
- 攻撃者が制御する入力: GitHub/GitLab/Bitbucket の Issue・PR・コメント本文（GitHubDialog が EMPTY_MD_IMAGE_SCOPE
  で描画）、およびエージェント出力の assista
- 脆弱なデータフロー: ![](https://attacker/p.png) → classifyMdImageSrc が remote 判定 → <img
  src="https://attacker/p.png"> を描画。allo
  はローカルファイル読取だけを塞ぎ、リモート 制限する CSP が無い。
- 悪用シナリオ: 第三者が作成した Issue に画 内でその Issueを閲覧した瞬間、被害者のブラウザが攻撃者サーバへリクエストし、IP
  アドレスと閲覧時刻が漏れる（脱匿名化・既読
- セキュリティ影響: プライバシー漏えい（IP・タイミング）。トークンは URL・Referer
  に載らないため資格情報漏えいには至らない（:// のため漏れない）。
- 推奨される緩和策: webview に Content-Security-Policy（img-src を self + 明示ホストに限定、default-src
  'none'）を付与するか、未信頼スコープ（allo もチップ表示にフォールバックさせる。
- Confidence: High。

LOW-2: /open-path によるエージェント選択パス

- ID: AGT-L2
- Severity: LOW- File: src/bun/server.ts /open-path（3962行.openPath =Utils.openPath（315行目）。呼び出し元は                                                                        SentFilesCard.tsx（278行目）、AttachmentChx（125行目）。
- 攻撃者が制御する入力: エージェントの SendUserFile ツールが指定するファイルパス（ワークツリー内に書いた         .command／.app／.html 等）。
- 脆弱なデータフロー: エージェントがワークツリーに実行可能スクリプトを書く → SendUserFile でそのパスを提示 →     ユーザがタイルの「Open」をクリック → POST macOS open 相当）が既定ハンドラで起動 →  スクリプト実行やアプリ起動。- セキュリティ影響: 「エージェントがファイル実行」に変換される。エージェントは既にサンド  ボックス無しで任意実行できるため OS レベル 明示的操作を介した実行トリガーを与える。- 既存の検証が不十分な理由: /open-path は絶  のみを行い、拡張子・封じ込め・実行可能性の ジェント選択・封じ込めなし」と CLAUDE.md  に明記）。- 推奨される緩和策: SendUserFile タイルの「O 張子ではプレビュー/Revealに限定するか、初回に確認ダイアログを出す。                                                                   - Confidence: Medium。

LOW-3: 非定数時間トークン比較＋全ルートでの ?token= 受理
                                                                                                               - ID: AGT-L3
- Severity: LOW（ハードニング）                                                                                - File: src/bun/server.ts isAuthorized（350–
- 内容: 認証は header === \Bearer ${API_TOKEN}`およびurl.searchParams.get("token") === API_TOKENの**非定数時間文字列比較**。また?token=` は SSE/WS だけでなく全ルートで受理される。
- 影響: ループバック上の 32 バイト乱数トークンに対する === のタイミング差の実用的悪用は現実的でない（HTTP 越しの計測ノイズ、ドライブバイはレスポンスを読めない）。?token= の全ルート受理はトークンが URL に載る経路を増やすが、リクエストロガーは存在せず（daemon-log.ts は特定イベント文字列のみ記録）、webview は該当  へ遷移しないため露出は限定的。
- 推奨される緩和策: crypto.timingSafeEqual による長さ一致・定数時間比較への置換。?token= はヘッダを設定できない <img>/EventSource/WebSocket 経路にのみ限定することを検討。
- Confidence: High（実装事実）／悪用可能性は極めて低い。

---
                                                                                                               Security Boundaries That Are Not Vulnerabili チャ境界）

1. エージェントはユーザの OS 権限を継承する（サンドボックスなし）。CLAUDE.md 明記。ワークツリーはソース分離であって OS 分離ではない。プロンプトインジェクションされたエージェントはユーザが読めるファイル（SSH                        鍵・各種トークン）をすべて読める。これは
2. ローカル API トークンは同一ユーザプロセス（エージェント含む）から可読。~/.agetor/agetor-core.json はモード 0600 で書かれる（core-creds.ts 62–72行目）が、同一ユーザのエージェントは読み取れ、フル API（タスク削除/開始、/open-path、/files/preview での任意ファイル読取、ユーザの git 資格情報を使った           commit/push・PR 作成）を駆動できる。ただ のファイルアクセスを持つため OSレベルの昇格ではない。トークンはもはやエージェント env に注入されておらず（claude-tmux.ts 6632行目）、これは正しい改善。API 自体は生トークンを返さない（/github/tokens は sanitizedTokenInfo でマスク）。ネットワーク経由の制御面をエージェントに与える点だけがファイルアクセス単独では得られない追加能力である。        3. ドライブバイ Web サイト／DNS リバインディ より無効。127.0.0.1バインド＋トークンゲート。CORS は access-control-allow-credentials: true で許可オリジンをエコー（不許可時は "null"）するが、認証は Cookie                                                                                  ではなくベアラートークンのため、クロスオ ークンを運べずレスポンスも読めない。/healthのみ未認証だがデータを返さない（app:"agetor" の自己識別子のみ）。防御多層の観点で "null"                       エコーは望ましくないが実用上無害。
4. commit/push は bun プロセス側の git push（ambient credential helper 利用）で実行。トークンを URL や http.extraheader に埋め込まず、エージェントの tmux セッション内でも実行しない（worktree.ts gitPush 630–655行目）。エージェントにプッシュ資格情報が露出しない良好な特性。                                       5. プロンプト配送はシェルを経由しない。claud → paste-buffer で配送、codex は <   promptfile、cursor は "$(cat <file>)" ＋シングルクォート。タスクタイトル・プロンプト・Issue 本文・エージェント出力がシェル文字列に補間される経路は見当たらない。
                                                                                                               ---
                                                                                                               Findings Investigated and Rejected（調査した
                                                                                                               - tmux send-keys へのキーストローク注入：/tming.choices  に登録済みのキーのみ許可（server.ts 4494行 み optionId のみ（4570行目）。任意キー送信は  400 で拒否。- モデル/モード/エフォート ID の passthroughl <value> 等は argv 要素として渡され、--model  --dangerously-skip-permissions としても値 mux ドライバでは sq  でシングルクォートされシェル解釈もされない- ハーネス env によるコマンド注入：buildHarn 394行目）は値を sq（'\''エスケープ）、キーを isValidEnvKey（[A-Za-z_][A-Za-z0-9_]*）で検証。tmux -e KEY=VAL も argv 要素。棄却。
- worktree 削除のパストラバーサル：resolveWorktreeDir（orchestrator.ts 5620行目）が /・\・..・空文字・basename 不一致を拒否し WORKTREES_DIR 直下の子に封じ込め。fs.rm は再帰中にシンボリックリンクを辿らない。棄却。        - @ ファイル参照によるワークツリー外読取：re 429行目）は isSafeRelPath に加えrealpathSync で realCwd + path.sep プレフィックスを検証（末尾セパレータバグなし）。シンボリックリンク脱出を拒否。棄却。
- 添付ファイル名によるパストラバーサル：sanitizeAttachmentBasename が NUL・/\・先頭ドットを除去し path.basename  で確定、openSync(..., "wx") で原子的排他作- deep link agetor://による副作用：parseTaskDeepLink（deep-link.ts）は厳格（scheme/host/単一セグメント/query・fragment 拒否）、ハンドラはタスクを選択して表示するのみ（index.ts 673行目）。開始/削除/回答は不可。棄却。
- SSRF による git-host トークン漏えい：GitHub は GITHUB_API_BASE を api.github.com に固定（github.ts 80行目）。  セルフホストトークンは解決後 API ホストの し、gitlab.com トークン/GITLAB_TOKEN/glabへのフォールバックを禁止（git-provider.ts gitlabSelfHostedToken、資格情報漏えい修正済み）。ホスト名は ssh -G -- <host> で解決し [a-z0-9.-] に制限。棄却。
- Markdown XSS：全 ReactMarkdown 呼び出しは remarkGfm のみ、rehype-raw/skipHtml なし、v10 は生 HTML              をテキストにエスケープ。リンクは ExternalL
- xterm ターミナルエスケープ悪用：WebLinksAddon 未ロード（fit のみ）、OSC 8/52 の任意起動経路なし。PTY はユーザ操作のシェルタブ。棄却。                                                                             
---                                                                                                            
Priority Remediation Plan（優先度順の是正計画）                                                                
1. （MEDIUM-1）git 実行のハードニング：全 git() ヘルパ（worktree.ts・project-files.ts・github.ts・git-provider.   env: { ...process.env, GIT_TERMINAL_PROMP"1" } を付与。読み取り専用の差分・列挙に   --no-ext-diff／-c core.fsmonitor=false、w範囲で -c   core.hooksPath=/dev/null。効果が最大の単2. （LOW-1）webview に CSP を追加：img-src/d   を限定し、未信頼スコープではリモート画像 ルを封じる。
3. （LOW-3）トークン比較を crypto.timingSafeEqual に置換し、?token= を <img>/SSE/WS 経路に限定。
4. **（LOW-2）SendUserFile/添付タイルの「Open」**を、実行可能・スクリプト拡張子で確認ダイアログ化または Reveal    限定に。
5. （INFO）~/.agetor を mkdir 時に mode: 0o700 で作成し、マルチユーザ機での横取り可能性を下げる（機微ファイルは   0600）。
                                                                                                               補足：本レビューは静的・読み取り専用で実施し ・ネットワーク通信・ファイル変更は一切行っていません。bun.lock に git/tarball 依存や postinstall は見当たらず、install.sh は sha256 チェックサム必須で TLS 1.2＋--proto '=https' を強制、fetch-tmux.ts omebrewバイナリを再配置する方式でした。サブエージェ限（HTTP429）で早期終了したため、全領域を私が直接精
