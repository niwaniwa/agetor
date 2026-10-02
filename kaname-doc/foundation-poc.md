# KANAME 基盤 PoC

実装・検証日: 2026-09-30  
基準コミット: `19fcc12503716f4625598c679849274564d8b131`

状態: 基盤 PoC のユーザー確認済み。2026-09-30、確認項目の提示後に「PoCは全部良さそう」との回答を受けた。以下の実装時の検証結果はそのまま保持する。systemd 導入・ホスト再起動・長時間運用など、個別の検証結果が記録されていない運用項目は引き続き残課題とする。

## 今回の範囲

Linux の常駐 headless 起動、認証付きブラウザー UI/API、Codex／Claude Code の手動起動・停止・ログ閲覧、ブラウザー再接続、サービス再起動後の実行状態復旧を実装した。

既存の Bun HTTP API、React Kanban、SQLite の Task／Run／イベント、tmux Runner、JSONL の読み取り、SSE 履歴配信を再利用した。既存デスクトップの Bearer token 接続は維持し、KANAME 専用のブラウザー入口を追加した。

`implementation-plan.md` の決定は維持する。**親 Issue ごとに一つの PR、重要な未決事項だけ質問、対応待ち一覧を正本とする通知、親2 Agent 時間・日次6 Agent 時間の変更可能な初期値**は後続の Issue／Workflow 実装の要件である。この PoC の既存 Task を完成版の Issue と見なさない。累積時間の予約・精算・強制停止、サービス停止中の独立した実行期限は未実装であり、利用上限を保証しない。外部通知先は未設定のまま。

## 起動

必要なものは Linux、Bun、tmux、`flock`（util-linux）、利用する CLI の既存ログイン。GUI、Electrobun の起動、macOS 用 vendor ビルドは不要。

```bash
bun install --frozen-lockfile
bun run build:web
bun run start:web
```

標準の UI は `http://127.0.0.1:4318`、内部 API は `127.0.0.1:4317`。ブラウザーのログイン画面にサーバーの `~/.kaname/web-login-token` の内容を入力する。トークンは初回起動で生成し、ファイル名だけを起動ログに表示する。ブラウザーの URL、HTML、localStorage には埋め込まない。

この作業環境では Bun 1.3.13 を `/tmp/kaname-bun/node_modules/.bin/bun` に用意し、依存関係を frozen lockfile で取得した。`/tmp` の Bun は検証用であり、常駐運用では持続する配置先の Bun を指定する。

現 checkout のビルド済み UI をこの環境で起動する場合:

```bash
/tmp/kaname-bun/node_modules/.bin/bun src/bun/kaname.ts
```

2026-09-30 の利用時に、プロジェクト登録で `Failed to fetch` との報告があった。調査時は4317／4318の両ポートが待受けておらず、指定された開発用ディレクトリ自体は存在していた。停止原因までは確認できていない。既存の `~/.kaname` データを使い、端末を閉じても継続する専用 tmux で復旧した。認証付き Web API でプロジェクト登録と一覧取得がともに HTTP 200 になることを確認した。

この復旧で使った起動コマンド（既に起動済みの場合は重ねて実行しない）:

```bash
tmux -L kaname-web-service new-session -d -s web \
  -c /home/nirila/project/agetor \
  env AGETOR_DATA_DIR=/home/nirila/.kaname AGETOR_API_PORT=4317 KANAME_WEB_PORT=4318 \
  /tmp/kaname-bun/node_modules/.bin/bun src/bun/kaname.ts
```

起動端末の表示は `tmux -L kaname-web-service attach -t web`。`Ctrl+B`、続けて `D` で稼働したまま離れられる。これは systemd の導入ではなく、ホスト再起動後の自動起動は設定していない。

| 設定 | 標準値・用途 |
|---|---|
| `AGETOR_DATA_DIR` | `~/.kaname`。DB、ログ、認証ファイル |
| `AGETOR_API_PORT` | `4317`。内部 CLI API |
| `KANAME_WEB_PORT` | `4318`。ブラウザー入口 |
| `KANAME_STATIC_DIR` | checkout の `dist`。ビルド済み UI |
| `AGETOR_TMUX_SOCKET` | 既存 Runner の規則に従う専用 socket。再起動時に変更しない |
| `AGETOR_BACKGROUND_DISCOVERY=0` | 起動時・周期的なモデル探索と利用状況取得を無効化。検証に使用 |

`AGETOR_BACKGROUND_DISCOVERY=0` は Settings からの明示的な再探索などを禁止するものではない。模擬検証では実 CLI を fixture に差し替える。

Codex は upstream の初期データでは無効になっているため、Settings で有効化する。プロジェクト追加では**サーバー上のディレクトリ**を入力する。小さな PoC タスクは一時ディレクトリと `isolation: none` を使用できる。ブラウザーから選択・ドロップしたファイルはアップロードし、サーバーのパスと取り違えない。

別端末からは SSH トンネルを使う。例:

```bash
ssh -N -L 4318:127.0.0.1:4318 your-server
```

接続元ブラウザーで `http://127.0.0.1:4318` を開く。Host 検査があるため、トンネルのローカルポートも `KANAME_WEB_PORT` に合わせる。サービスは loopback のみに bind し、インターネット公開やリバースプロキシ運用はこの PoC の範囲外。

## systemd

`deploy/kaname.service` を user unit の雛形として用意した。`WorkingDirectory` と `ExecStart` を実際の checkout／Bun のパスに合わせ、必要に応じて `~/.config/kaname/kaname.env` に環境設定を書く。

```bash
mkdir -p ~/.config/systemd/user
cp deploy/kaname.service ~/.config/systemd/user/kaname.service
# 上記二つのパスを編集してから実行する
systemctl --user daemon-reload
systemctl --user enable --now kaname.service
```

この開発作業では user unit のインストール・有効化は行わない。ログアウト後も動かす設定（user lingering）の要否は導入先で確認する。

KANAME 起動ではアイドル自動終了を無効化する。unit の `KillMode=process` は、サービス再起動中も tmux 内の CLI を生かして復旧するための設定である。**サービスの stop はタスクのキャンセルではない**。作業自体を止める場合は先に UI の Stop を使う。ホスト再起動で CLI が消えた場合は、ログから回収できる結果を反映し、それ以外は orphaned／Ready に戻して明示操作を待つ。

## 認証と復旧の仕組み

- ブラウザー入口はランダムなログイントークンを照合し、期限24時間の `HttpOnly; SameSite=Strict` Cookie を発行する。HTTP loopback 用のため Secure 属性は付けない。セッションは SHA-256 ハッシュで SQLite に保存し、再起動しても有効期限内のログインを保持する。logout は保存済みセッションを失効させ、接続中の SSE／WebSocket も閉じる。
- Host と Origin を検査し、書き込みと WebSocket は同一オリジンを必須とする。gateway はブラウザーの Authorization／query token を認証に使わず、内部 API 用資格情報を付け直す。静的配信は `dist` 内だけに制限し、外への symlink を拒否する。
- `web-login-token` と `core-api-token` は別の mode 0600 ファイル。後者は tmux に残る CLI と再起動後のサービスの接続を保つために固定する。ログイントークンを正しい64桁の乱数hexに置き換えてサービスを再起動すると、旧ログインセッションを失効させられる。
- `flock` による data directory の所有権を DB 初期化・復旧より前に取得する。サービスが SIGKILL で落ちても専用 pipe の EOF でロックを解放する。二重起動による二重の復旧処理を防ぐ。このロックは KANAME 同士の協調であり、legacy Agetor／デスクトップとデータディレクトリを共用しない。
- ブラウザー再接続時に一覧・実行・質問の状態を取り直し、既存 SSE の保存履歴を再配信する。event ID cursor による差分配信ではなく、bounded replay と重複排除である。長時間切断で窓が重ならない場合は新しい窓に切り替え、古いログは Load earlier で取得する。
- Codex は tmux が消えていても未処理の run 固有 JSONL から終了結果を回収する。thread ID の保存前に落ちた起動、run 間で再利用される item ID、古い重複 running 行の処理も修正した。回収できない実行を成功扱いにしたり、自動で再起動したりしない。
- Linux で Codex の全標準入出力をファイルへ redirect して `exec` すると、PTY の slave が閉じて起動直後に SIGHUP で落ちる問題を再現した。wrapper shell に端末を保持させ、Codex の終了コードを返す方式に変更した。

## 検証結果

実行環境は Linux、Node.js 24.18.0、Bun 1.3.13、tmux 3.6、Codex CLI 0.159.0、Claude Code 2.1.285。Codex は既存 ChatGPT ログインを利用。Claude Code は当初2.1.241で未ログインだったが、ユーザーによるログイン・更新後に実タスクを検証した。

| 検証 | 結果 |
|---|---|
| `bun run typecheck` | 成功 |
| `bun run build:web` | 成功。既存 bundle のサイズ警告あり |
| gateway HTTP／SSE／WebSocket | 15件・89 assertions 成功。認証拒否、Host／Origin、永続セッション、失効／logout、Cookie 属性、資格情報除去、静的配信の閉じ込め、上流停止を確認 |
| KANAME 復旧と所有権 | 11件・49 assertions 成功。Codex／Claude の JSONL モック、終了／失敗、重複ログ、古い running 行、復旧後の停止、ロックと SIGKILL を確認 |
| ブラウザー側の関連単体テスト | 76件成功。接続方式、ログ重複排除、再接続窓、ファイル取得、既存 retry 処理 |
| 既存 API 回帰 | 33件・119 assertions 成功。`server-auth`、`headless-routes`、`server-sse-initial-frame`、`server-events-anchor` を各別プロセスで実行 |
| Runner の関連回帰 | 34件・103 assertions 成功（headless idle、lock、Codex、KANAME recovery。上記11件を含む）。別実行の既存 `reconcile.test.ts` 13件も成功 |
| 実 tmux と模擬 CLI のプロセス統合 | 全9項目成功。`/tmp/kaname-smoke-k24n8b` にログ・DB。SIGKILL 復旧、同じ Run の停止、停止中の終了回収、二重起動なし |
| 実 Chromium と模擬 CLI | 全9項目・173リクエスト成功。`/tmp/kaname-browser-Mxv9a7` に結果とスクリーンショット。ログイン、サーバーディレクトリ登録、両 CLI の操作・ログ、reload、offline／online、画面を開いたままのサービス再起動、SSE 再接続、重複排除、logout を確認 |
| 実 Codex CLI | 成功。`/tmp/kaname-cli-H7wr4Y/task/numbers.txt` の `4,7,9` を読み、合計20と完了文字列を確認。サービス再起動後も同じ Run 一件で完了、assistant ログ保存、別実行のキャンセルも確認 |
| 実 Claude Code | 成功。2.1.285 と既定の Opus 5.5 を使用。`/tmp/kaname-cli-DqlZU0` で `sleep 8` の実行中にサービスを再起動し、同じ Run 一件のまま読み取り結果20と完了文字列・assistant ログ保存を確認。別実行は `sleep 60` の tool event 保存後にキャンセル |

全 upstream テストの一括実行は行っていない。既存テストの環境変数と module cache の干渉を避け、関連するテストを分けて実行した。Linux mock が `/bin/echo --version` を CLI 版数と誤認するテストのみ `AGETOR_SKIP_CLI_VERSION_FLOOR=1` を使用し、製品の版数チェックは維持した。

再実行可能なモック統合検証:

```bash
bun run build:web
bun run test:kaname-smoke
```

`scripts/kaname-smoke.ts` は `/tmp/kaname-smoke-*` に専用データを作り、実 HTTP／SQLite／専用 tmux と模擬 CLI で start、cancel、SSE、SIGKILL 復旧、サービス停止中の終了、重複起動なしを確認する。実行終了時にサービスと専用 tmux server を停止する。通常の tmux server や利用者の DB は操作しない。Linux の socket 待受けが必要である。

このモックは Python 3 も使う。ブラウザー検証は `bun run test:kaname-browser`（Playwright Chromium が必要）。`scripts/kaname-cli-smoke.ts --real` は実アカウントを利用する明示起動用の別スクリプトで、通常のテストには含めない。いずれも一時ディレクトリの非 Git タスクだけを使う。

この環境のブラウザー検証では Chromium、足りない共有ライブラリ、フォントを `/tmp/kaname-playwright` に配置し、OS のパッケージは変更しなかった。再実行時の環境指定:

```bash
PLAYWRIGHT_BROWSERS_PATH=/tmp/kaname-playwright \
LD_LIBRARY_PATH=/tmp/kaname-playwright/libs/usr/lib/x86_64-linux-gnu \
FONTCONFIG_FILE=/tmp/kaname-playwright/fonts.conf \
/tmp/kaname-bun/node_modules/.bin/bun scripts/kaname-browser-smoke.ts
```

実 Codex 検証は既存ログイン、`mode: ask`（read-only sandbox）、`isolation: none` を使った。CLI への指示は sleep と当該ファイルの読み取りだけとし、Git、外部通知、委譲、ファイル変更を禁止した。smoke 終了時にサービスと専用 tmux を停止した。

保存された実 Codex の tool event は `cat numbers.txt` の一件。実 Claude は `sleep 8`、対象ファイルの Read、キャンセル用の `sleep 60` のみで、Git 操作・外部通知・委譲は記録されていない。Claude の検証起動だけに `--safe-mode --no-chrome --tools Read,Bash --allowedTools Read,Bash(sleep:*)` を付け、カスタマイズ・外部連携を無効化し、待機コマンドだけを事前許可した。製品の ask モードや通常の利用者設定は変更していない。CLI のログイン・更新はユーザーが行った。

当初の Claude 2.1.241 は既定の Opus 5.5 に対して「2.1.280以上が必要」という API エラーになった（`/tmp/kaname-cli-WmB2OD`）。失敗状態とエラーが記録され、自動再試行は行われなかった。2.1.285への更新後に上記の全項目が成功した。導入先でも選択モデルと CLI の対応を確認する。

実アカウントを使う検証の明示実行:

```bash
bun scripts/kaname-cli-smoke.ts --real
bun scripts/kaname-cli-smoke.ts --real --claude
```

## 残課題

- 第15節の要件案・質問と回答・通知 outbox・累積 Agent 時間制御と、Issue／Workflow の状態機械。
- CLI 内部委譲の無効化と厳密な実行数上限。既存の CLI 権限や worktree は OS ユーザー単位の隔離ではない。
- 永続的な人向け Issue。今回再接続で取り直す既存 interaction は完成版の永続判断記録ではない。
- systemd user session の実機有効化、ホスト再起動、長時間稼働、ネットワーク公開／TLS は未検証。
- 既存セキュリティ資料の指摘（設定 symlink、信頼確認、Git 補助プログラム、同一ユーザーの資格情報等）は未修正。レビュー文書に対象 SHA が記録されていないため、文書とこの checkout の完全一致は断定しない。基準 checkout 自体は計画の SHA と一致する。

commit、push、PR 作成、マージ、remote／履歴変更は行わない。実 GitHub 書き込みや実サービスへの外部通知は検証に使用しない。
