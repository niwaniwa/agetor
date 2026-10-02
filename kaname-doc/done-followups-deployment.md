# 完了時の追加タスク起票 — 稼働版への反映

反映日: 2026-10-02  
結果: 稼働版への取り込み、DB 更新、再起動、ブラウザー確認まで完了。

## 反映対象

- レビュー済みの開発用コピー: `/tmp/kaname-followups-1h2gw4t2/agetor`
- 稼働用コード: `/home/nirila/project/agetor`
- 既存データ: `/home/nirila/.kaname`
- ブラウザー入口: `http://127.0.0.1:4318`
- 内部 API: `127.0.0.1:4317`
- 管理サービス: `tmux -L kaname-web-service` の `web` セッション。

ユーザーの反映指示に基づき、基準コピーから変わった23ファイルだけを取り込んだ。既存の基盤 PoC の未コミット変更を保持し、稼働側だけで更新されていた `foundation-poc.md` は上書きしていない。取り込み前後のファイルハッシュで対象を照合した。以下の反映記録と案内文の更新は、取り込み後の文書整備である。

## バックアップ

保存先:

```text
/home/nirila/.local/state/kaname/backups/20261002T165016Z-done-followups-42xuxnri
```

保存先は本人だけがアクセスできるディレクトリとして作成した。

- `code-before.tar.gz`: 反映前のコード、未コミットファイル、ビルド済み `dist`。`.git` と依存関係の `node_modules` は除外。
- `data/`: 停止後の `~/.kaname` 全体。SQLite の WAL、認証情報、ログを含む。
- `manifest.json`: 対象23ファイルの反映前後のハッシュ。
- `database-before.json`: 既存データの件数・列・内容ハッシュ。
- `service-environment.json`: 元のサービスの起動環境。
- `credential-fingerprints.json`: 認証ファイルの照合値。
- `deployment-state.json`: 作業段階と完了結果。
- 各チェックの `.log`: テスト、型検査、ビルドの結果。

バックアップは管理サービスの停止完了とロック取得後に作成した。コピーした SQLite に対する `quick_check` も成功した。

## 反映と検証

反映前に、実行中 Run・タスク・subagent、予約済み FX 自動再開、進行中 Pipeline がないことを確認した。管理用 Bun だけを停止し、既存のデータ領域・ポート・起動環境を維持して起動した。Runner の `AGETOR_TMUX_SOCKET` は引き続き未指定であり、管理サービスの socket と混同していない。

起動時に `061_done_followups` が一度だけ適用された。既存 Task／Run の追加設定はすべて OFF、新設の候補・要求・関連テーブルは空で、過去のタスクから自動起票されていない。

| 確認項目 | 結果 |
|---|---|
| 関連・移行・起動経路のテスト | 31 成功、0 失敗、190 assertions |
| headless API 回帰テスト | 5 成功、0 失敗、22 assertions |
| 型検査 | 成功 |
| Web ビルド | 成功。既存 Vite 警告のみ |
| `git diff --check` | 成功 |
| 起動後 SQLite `quick_check` | 成功 |
| 新しい API | 既存タスクの追加タスク設定・状態を取得できる |
| 認証 | ログイン・ログアウト成功。ログイントークンと内部 API トークンの内容は反映前と一致 |
| 稼働版の実 Chromium | ログイン、新しい設定項目の表示と初期 OFF、既存 Review タスク、再読み込み後の認証保持を確認 |

反映前後で、既存列の内容ハッシュと件数が一致した:

| データ | 件数 |
|---|---:|
| タスク（アーカイブを含む） | 3 |
| 実行履歴 | 4 |
| 実行ログ | 477 |
| プロジェクト | 3 |

実装タスク `f0061dd1-12b0-4186-b013-1bb9d31423ab` は Review のまま、最新 Run は `79101e59-4f3f-4803-a758-14fc5815c39e` のまま保持した。確認のためのタスク作成・CLI 起動・既存タスクの設定変更は行っていない。起票の動作自体は、[再レビュー](done-followups-review.md) の隔離環境で実 CLI と実ブラウザーにより確認済み。

稼働画面の証跡は `/tmp/kaname-live-browser-HA659J/result.json` と同じディレクトリの `deployed.png`。最初の画面確認では検証ツールのログアウト処理に Bun／Playwright の URL 解析エラーがあったため、ブラウザー内の fetch に変更して再確認し、終了コード0で完了した。アプリケーション側の変更は不要だった。

## 利用方法

既存のブラウザーを再読み込みし、新規タスクの作成画面またはタスク詳細で **Create follow-up tasks when Done** を実行前に ON にする。成功後の Review で候補を確認し、人が Done にすると Backlog へ起票する。生成タスクは未実行・設定 OFF の状態で保存される。

反映前の Run に後から候補を追加する動作ではない。既存の実装タスクを Done にするだけでは候補は生成されない。

commit・push・PR 作成・マージ・remote／履歴変更は行っていない。systemd 導入やホスト再起動時の自動起動設定は今回の反映範囲に含めていない。
