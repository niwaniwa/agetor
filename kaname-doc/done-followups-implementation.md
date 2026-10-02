# 完了時の追加タスク起票 — 実装・検証記録

更新日: 2026-10-02  
実装・検証時の対象: 開発用コピー `/tmp/kaname-followups-1h2gw4t2/agetor`

2026-10-01 の再レビューで P2・P3 の修正と、実 Chromium・実 Codex／Claude Code による動作を確認した。詳細と証跡は [追加レビューの最新の判断](done-followups-review.md) を参照。2026-10-02 に別途のユーザー指示で `/home/nirila/project/agetor` の稼働版へ反映した。バックアップ・データ保持・再起動の結果は [反映記録](done-followups-deployment.md) に記録する。

## 実装した内容

通常の Codex／Claude Code タスクに、初期値 OFF の「Done 時に追加タスクを起票」設定を追加した。ON のまま開始した Run だけが、終了時に同じ CLI の出力から厳格なタグ付き JSON 候補を最大 5 件保存する。Review では候補を表示するだけで、Done の通常操作が SQLite の同一トランザクションで要求を登録した後に、独立した Backlog タスクを作る。

候補出力の形式は `<kaname-followups>{"candidates":[...]}</kaname-followups>` とし、未知の項目、空文字、不正 JSON、タグの重複、6 件以上をすべて失敗として保存する。部分的な採用や推測起票はしない。候補本文が指定できるのはタイトル・根拠・範囲・合格条件だけで、起票先、状態、作業ディレクトリ、CLI 設定、Git／通知／API 実行を指定・実行できない。

生成タスクは同一プロジェクト／基準 workdir と Agent・モデル・権限モード・分離方式を引き継ぐが、Backlog・未実行・follow-up 設定 OFF で作る。一時 worktree、branch、PR、Run／CLI session、Pipeline、profile は引き継がない。生成元と生成先には永続的な双方向リンクを保存し、詳細画面から相互に開ける。

## 仕様・合格条件との対応

| 合格条件 | 実装・検証の対応 |
|---|---|
| 1 | `tasks` と `runs` の `done_followups_enabled` は migration 061 で既定 0。起動時にのみ ON を snapshot し、OFF はプロンプト追加も候補収集も行わない。 |
| 2 | 通常 Codex／Claude Code の開始経路でプロトコルを注入し、成功時に候補だけを保存する。専用 fake CLI 統合試験はこの注入を確認する。 |
| 3 | Done と request 登録、候補からの child／リンク作成を各 SQLite transaction にし、Backlog task と双方向クリックリンクを提供する。 |
| 4 | 0 件、欠落、不正 JSON、上限超過を別状態で保存・表示する厳格 parser の試験を追加した。 |
| 5 | child は `runId: null`、Backlog、設定 OFF で `tasks.insert` するだけで、CLI／Run／自動開始を呼ばない。 |
| 6 | 最新 Run、成功、snapshot、現在の ON、待機作業なしを Done 直前にも再検査し、古い Run は抑止理由を保存する。 |
| 7 | source Run ごとの一意 request と candidate ごとの一意 link で、再送・連打・再処理を冪等化した。 |
| 8 | 起動時に保存済み assistant event から未収集候補を回復し、pending／processing request を再確認して回収する。child 作成は一括 transaction である。 |
| 9 | child 作成失敗は候補を残した `failed` request とし、明示 retry は保存済み候補だけを使う。 |
| 10 | OFF、Run 差替え、Done 取消、archive／削除、待機作業を作成直前に再検査し、抑止を永続化する。既存 child は変更しない。 |
| 11 | child は worktree、branch、PR、base ref、session を null にし、元の通常起動処理へ委ねる。 |
| 12 | 起票処理は DB 内の `tasks.insert` と relation 保存だけで、GitHub、通知、Git、追加 CLI を呼ばない。 |
| 13 | 終了後に保存済み assistant event から collection を再構築する recovery 試験を追加した。 |
| 14 | Run snapshot と Done 時の現在 ON を分離し、対象外 CLI／Pipeline の UI 非表示・API 有効化拒否を実装・試験した。 |

Done 操作の直後に待機作業が見つかった場合は、起動時だけの回収に永久保留されないよう `pending-work` で永続的に抑止する。次の通常 Run と明示的な Done 操作が新しい対象になる。

## 追加レビュー対応（2026-09-30）

- P2 — ON で収集済みの候補を Review で OFF にして Done した場合の抑止は、起動時 recovery では引き続き回収しない。一方、人が Review に戻して ON にし、改めて Done を押した場合は、現在の条件を通過してから同じ request／candidate を `pending` に戻す。新しい request や candidate を作らないため、生成は一度だけである。
- P3 — Run 開始時も Done 時も OFF で、collection／request も存在しない通常タスクは、Done 時に `suppressed / disabled` 行を保存しない。これにより Follow-up panel は表示されない。実行開始時 ON、後から ON にした旧 Run、既存の collection／request は抑止理由と監査履歴を維持する。

## 変更ファイル

- 永続化・型・移行: `src/shared/types.ts`、`src/bun/db.ts`、`src/bun/migrations/061_done_followups.sql`、`src/bun/migrations/index.ts`、`src/bun/migrate.test.ts`
- 候補 protocol／原子処理／復旧: `src/bun/done-followups.ts`、`src/bun/done-followups.test.ts`、`src/bun/done-followups-orchestrator.test.ts`
- 実行・API・起動時回収: `src/bun/orchestrator.ts`、`src/bun/server.ts`、`src/bun/headless.ts`、`src/bun/index.ts`、`src/bun/agents.ts`
- Web UI: `src/mainview/components/kanban/NewTaskForm.tsx`、`src/mainview/components/kanban/RunPanel.tsx`、`src/mainview/App.tsx`、`src/mainview/lib/api.ts`
- ブラウザー定義: `e2e/done-followups.spec.ts`

開始時点で存在した未コミットの基盤 PoC 変更は保持し、上記以外を今回の機能変更として扱っていない。

## 検証結果

- `PATH=/tmp/kaname-bun/node_modules/.bin:$PATH /tmp/kaname-bun/node_modules/.bin/bun test src/bun/migrate.test.ts src/bun/done-followups.test.ts src/bun/done-followups-orchestrator.test.ts` — 成功（31 pass、0 fail、190 assertions）。成功、0 件、不正／上限超過、OFF／snapshot、待機作業、原子失敗→retry、再送、再起動回収、古い Run 抑止、プロンプト注入に加え、P2 の再 ON／明示 Done 復帰と P3 の初期 OFF が静かなままの Done を確認。
- `PATH=/tmp/kaname-bun/node_modules/.bin:$PATH /tmp/kaname-bun/node_modules/.bin/bun run typecheck` — 成功。
- `PATH=/tmp/kaname-bun/node_modules/.bin:$PATH /tmp/kaname-bun/node_modules/.bin/bun run build:web` — 成功。既存の Vite native config／chunk size warning のみ。
- `PATH=/tmp/kaname-bun/node_modules/.bin:$PATH /tmp/kaname-bun/node_modules/.bin/bun ./node_modules/@playwright/test/cli.js test e2e/done-followups.spec.ts --project=chromium --list` — 成功（3 browser test 定義を収集）。定義には ON → Review → Done → Backlog、0 件・不正・上限超過、対象外 API 拒否、source → generated → source 遷移を含む。

テストは専用の一時 `AGETOR_DATA_DIR` を使い、実サービス、通常の tmux server、`/home/nirila/project/agetor`、`~/.kaname` を変更していない。GitHub 書き込み、通知、Git の外部操作も行っていない。commit／push／PR／merge／remote・履歴変更も行っていない。

## 初回・修正担当環境での制約（後の再レビューで動作確認済み）

- 実ブラウザーの Playwright 実行を再試行したが、sandbox では Bun.serve の `127.0.0.1` port 0 も起動できず、Vite 5173 は `listen EPERM`、Chromium／headless-shell 実体も未導入だった。上記の browser test は収集のみ成功であり、実ブラウザー成功とは扱わない。
- 実 Codex CLI（`0.159.0`）の読み取り専用一時タスクを隔離 `/tmp` で再試行した。`--sandbox workspace-write` と `--disable code_mode_host` を含む二通りとも、プロンプト開始前に app-server が `Read-only file system (os error 30)` で失敗（exit 1）した。実 Claude Code（`2.1.285`）は Read 限定で API retry `error:"unknown"` が 8 回継続し、Ctrl-C で終了（exit 130）した。両 fixture は削除済みで、残存 child process はない。どちらも機能成功の証拠ではない。
- `src/bun/headless-routes.test.ts` を含む結合実行は、固定 port 4467 の `EADDRINUSE` で API 起動前に失敗した。今回の Done-followups 専用試験・型検査・Web build には影響していないが、待受を許可する環境で再確認する。

上記の失敗は当時の実行環境での記録である。2026-10-01 にローカル待受を許可した隔離実行で、ビルド済み UI と実 Chromium、両実 CLI の候補収集・Review・サービス再起動・Done 起票・再送を確認した。初回 OFF、再 ON、双方向リンク、0件／不正／上限超過も実ブラウザーで確認した。既存の `e2e/done-followups.spec.ts` 3件そのものの実行成功とは区別し、別の gateway 用検証スクリプトを使った。再実行方法と結果は [追加レビュー](done-followups-review.md) に記録した。
