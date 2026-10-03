# 単一担当の開発ワークフロー — 稼働版への反映

作業日: 2026-10-03 UTC。ユーザーの「コミット、稼働版への反映を実施」という指示で実施した。

状態: 実装コミット `be053d8`（`feat: add single-assignee development workflow`）を稼働版へ反映済み。公開先は `https://kaname.niri.la`。既存の Cloudflare Access と KANAME 認証を使用する。

## 使い始める

1. 公開画面を再読み込みし、ヘッダーの「開発ワークフロー」を開く。
2. 「設定」で対象プロジェクト、remote、基準ブランチ、担当 CLI・モデル・effort、検証コマンドを設定する。
3. GitHub に書き込むプロジェクトで「GitHub への push・PR 作成を有効にする」を明示的に ON にする。初期値は OFF。
4. 依頼を Backlog に保存し、内容・設定を確認して Ready にする。マージには対象 SHA に対する人の承認が別途必要。

詳細は [仕様と操作方法](single-assignee-workflow.md#画面から使う手順) を参照する。今回の稼働確認では依頼を作成せず、CLI 実行や GitHub 書き込みを開始していない。

## 反映手順とバックアップ

通常タスクの実行、subagent、Pipeline、復旧予約、Done 追加タスク生成に実行中の処理がないことを確認した。サービスを停止して、データディレクトリ全体と反映前のソース・UI を次に保存した。

```text
/home/nirila/.local/state/kaname/backups/20261003T144217Z-workflow-be053d8
```

- `data/`: 停止後の `~/.kaname` 全体。DB、WAL、認証情報、ログ、worktree を含む。
- `source-before.tar`: 基準コミット `b1e370f` のソース。
- `dist-before.tar.gz` / `dist-before/`: 反映前に配信していた UI。

バックアップディレクトリは mode 700、アーカイブは mode 600。バックアップ DB の `quick_check` は正常。機密情報を含むため Git には追加しない。

分離環境 `/tmp/kaname-workflow-y93ao6ku/agetor` で検証・ビルドした `dist` を `dist.next` にコピーし、内容一致を確認してから停止中に差し替えた。稼働 checkout 内での再ビルドは行っていない。

管理サービスは従来の tmux 起動を維持した。2026-10-03 14:55:24 UTC に新しい版が起動し、確認時の Bun PID は `3037434`。

```sh
tmux -L kaname-web-service new-session -d -s web -c /home/nirila/project/agetor \
  'exec env AGETOR_DATA_DIR=/home/nirila/.kaname AGETOR_API_PORT=4317 KANAME_WEB_PORT=4318 KANAME_PUBLIC_ORIGIN=https://kaname.niri.la /tmp/kaname-bun/node_modules/.bin/bun src/bun/kaname.ts'
```

Cloudflare Tunnel の設定と中継用 systemd user unit は変更していない。管理本体は tmux、新ワークフローの各 CLI 実行は systemd user unit で管理する。ホスト再起動後の管理本体の自動起動は今回追加していない。Bun は `/tmp` 配置のため、消去時には再準備が必要。起動・中継の詳細は [Cloudflare 接続の運用手順](cloudflare-access.md#kaname-本体の手動再起動) を参照する。

## 反映後の確認

| 確認 | 結果 |
|---|---|
| DB 整合性 | 反映前後とも `PRAGMA quick_check = ok` |
| migration | `062_development_workflows` を1回適用。既存001〜061は内容一致 |
| 既存タスク・実行・ログ・プロジェクト | 7・10・597・3件。件数・内容ハッシュが反映前と一致 |
| タスク状態 | Done 6件、Review 1件を保持 |
| 新しい workflow テーブル | 10テーブル、すべて空。既存 Task を自動変換・起動していない |
| その他の既存テーブル | 件数一致。内容差分は自動更新される利用量キャッシュ `harness_usage.snapshot_json` / `updated_at` のみ |
| 認証情報 | ログイントークンと内部 API トークンは反映前と同一 |
| 既存ブラウザーセッション | 期限内の2件を保持。ID・有効期限・認証世代が反映前と一致 |
| 未ログインアクセス | gateway と内部 API の新 workflow API が401を返す |
| Docker bridge と公開 Host | `172.20.0.1:4318` 経由、Host `kaname.niri.la` / Origin `https://kaname.niri.la` で認証・新 API が成功 |
| 公開 Cookie と Origin 制御 | `__Host-` / Secure / HttpOnly、異なる Origin の403拒否を確認 |
| SSE | 中継経由の従来イベントと workflow イベントが200で配信を開始 |
| 実 Chromium | localhost でログイン、新画面・設定・上限初期値、既存7件の取得、再読み込み後の認証と画面表示が成功。未処理例外なし |
| 検証用セッション | localhost・公開 Host の確認用セッションをログアウトし、API が401になることを確認 |
| 公開 URL | Cloudflare Access のサインイン画面へのリダイレクトを確認 |
| 待受け | `127.0.0.1:4317`、`127.0.0.1:4318`、`172.20.0.1:4318` を保持 |

稼働版のブラウザー・API 確認スクリプトは14項目成功。最終結果と画面画像は `/tmp/kaname-workflow-live-JxC77W/` に保存した。一時ファイルのため永続保存は保証しない。最初の確認では検証スクリプトの Playwright API ログアウト処理で Bun の URL 処理例外が出たため、ブラウザー内の fetch に変更して再実行し、正常終了を確認した。

CLI の準備状況は Bun 1.3.13、Codex 0.159.0、Claude Code 2.1.285 で許可リストと一致。稼働プロセスの環境でも両 CLI のバージョン一致を確認した。systemd 259.5、cgroup v2、user manager と linger を確認した。user manager 全体の `degraded` は、分離環境の停止試験 unit `kaname-workflow-smoke-1790978324990-cancel.service` と `kaname-workflow-smoke-1790978324990-cancel-deadline.service` が失敗状態として残っていることによる。稼働中継の socket/service はともに active。今回の反映では実 CLI ジョブを起動していない。

## 残課題と復元時の注意

公開 URL で Cloudflare Access 本人認証後の一連の自動確認は未実施。localhost の実ブラウザーと、公開 Host を使用する Docker bridge 経由で確認した範囲を区別する。

実 GitHub の push・PR 作成・レビュー・マージまでを通す試用は未実施。GitHub 書き込みは引き続きモックでの検証結果を参照する。外部通知、複数担当、デプロイ自動化は後続。

復元が必要な場合は、稼働中の通常 Task と workflow の systemd worker を確認・停止し、復元直前のデータも別に退避する。ソース・UI・DB の組をそろえて戻し、同じ公開 origin と認証情報で起動する。反映後に作成した依頼・成果を失わないよう、上記バックアップで現在の DB を無条件に上書きしない。migration 062 の自動ダウングレードは用意していない。

今回、実装と反映記録のローカルコミットを行った。push、実 PR 作成・マージ、remote 変更、履歴の書き換え、外部通知は行っていない。
