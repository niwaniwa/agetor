# Done 時の追加タスク起票 — 追加レビュー

最終確認日: 2026-10-01  
対象: `/tmp/kaname-followups-1h2gw4t2/agetor`  
KANAME タスク: `f0061dd1-12b0-4186-b013-1bb9d31423ab`  
最新の確認対象 Run: `79101e59-4f3f-4803-a758-14fc5815c39e`  
初回の確認対象 Run: `a19398d5-66e1-41f1-aac4-111b5d474721`

## 最新の判断（2026-10-01）

前回の P2・P3 は修正を確認した。今回の再レビュー範囲で新たな修正必須の不具合は見つからず、開発用コピーの実装タスクは Done に進めてよいと判断する。実装担当の成功報告だけでなく、コードの照合、テスト再実行、実 Chromium、実 Codex／Claude Code の隔離タスクで裏付けた。

元の実装タスクは Review のまま維持した。稼働版への反映はこの確認に含めていない。

### 再レビューの検証結果

- 関連・移行・起動経路のテスト: **31 成功、0 失敗、190 assertions**。前回と同じ3ファイルを再実行した。
- `bun run typecheck`、`bun run build:web`、`git diff --check`: 成功。ビルドには既存の Vite 警告のみ。
- 前回の P2 再現スクリプトを変更せず再実行: `OFF Done → Review/ON → Done` が `queued → succeeded` となり、生成数 **1 件**。回帰テストでは再送後も増えないことを確認。
- 実 Chromium + 隔離 KANAME gateway + 偽 CLI: **成功**。初期 OFF、詳細画面での ON、UI の Run → Review → Done、未実行・設定 OFF の Backlog 生成、双方向リンク、P2 の再 ON、P3 の未使用時の非表示、0件／不正／上限超過、再読み込み後の関連保持を確認。未処理の JavaScript 例外なし。
- 実 Codex (`gpt-5.6-terra`、低推論強度、読み取り専用): **成功**。
- 実 Claude Code (`claude-opus-5-5`、低推論強度、Read のみ・safe-mode): **成功**。

両実 CLI はそれぞれ一時ディレクトリの `numbers.txt` を読み、合計 20 を返した。同じ Run から候補1件を保存し、Review では未起票、サービス再起動後も候補と認証セッションを保持、明示 Done 後に関連付き Backlog を1件生成、再送で重複せず、生成タスクには Run がなく設定 OFF であることを API／保存ログで確認した。

ブラウザー検証は `e2e/done-followups.spec.ts` の3件をそのまま実行した結果ではなく、ビルド済み Web UI を実 gateway で開く別の隔離スクリプトによる。最初の試行では通常導線を通過した後、検証コードが一時的に存在しないスイッチを根拠に詳細欄を閉じてしまった。対象タスクの表示と詳細欄の開閉状態を待つよう検証コードのみ修正し、全操作を再実行して成功した。アプリケーションのコードは変更していない。

### 証跡と再現用スクリプト

- 実 CLI スクリプト: `/tmp/kaname-followups-real-review.ts`。Bun で `--real` を指定すると Codex、`--real --claude` で Claude。専用 DB・動的ポート・tmux socket を毎回作成する。
- Codex 証跡: `/tmp/kaname-followups-real-3Gi54U`。
- Claude 証跡: `/tmp/kaname-followups-real-dgJ7Sx`。
- ブラウザースクリプト: `/tmp/kaname-followups-browser-review.ts`。
- ブラウザー結果: `/tmp/kaname-followups-browser-hCWUdI/result.json`。
- 確認画面: `/tmp/kaname-followups-browser-hCWUdI/browser.png`。

ブラウザーには `PLAYWRIGHT_BROWSERS_PATH=/tmp/kaname-playwright`、`LD_LIBRARY_PATH=/tmp/kaname-playwright/libs/usr/lib/x86_64-linux-gnu`、`FONTCONFIG_FILE=/tmp/kaname-playwright/fonts.conf` を指定した。いずれも sandbox のローカル待受制限を解除する承認済みの実行で成功した。稼働中のサービスを使わず、試験で起動したサービス・ブラウザー・専用 tmux server は終了している。

## 初回の判断（2026-09-30、以下は履歴）

Run は成功し、タスクは Review にある。実装の主要経路は用意されているが、以下の修正と未確認項目の検証を終えてから Done を判断する。今回の追加レビューでは実装コード・稼働サービス・元タスクの状態を変更していない。

## 指摘

### P2: 過去の抑止が、新しい有効な Done 操作も無効にする

再現手順:

1. 設定 ON で正常終了し、有効な候補を保存する。
2. Review で設定を OFF にし、Done にする。この時点で起票しないのは正しい。
3. Review に戻し、設定を ON にする。
4. 再び Done にする。

4 では起票条件を満たすが、追加タスクは 0 件のままになる。一時 DB で再現した。`src/bun/done-followups.ts` の `queueRequestInner` は既存の抑止済み要求をそのまま返し、`processRequestInner` は `suppressed` を再検証しない。結果は `already-queued` → `suppressed` になる。

過去の未処理要求を自動回収しないことと、人による新しい Done 操作を受け付けることを分ける必要がある。新しい明示操作時に現在の条件を再確認し、未起票候補を一度だけ作成できるようにする。生成済み候補・編集済み／削除済みタスクを再作成しない制約は保つ。

### P3: 一度も有効化していないタスクにも抑止表示が出る

通常の初期 OFF タスクを実行し、Review → Done とするだけで `suppressed / disabled` の要求が保存される。`RunPanel.tsx` の `DoneFollowupsPanel` は要求があると表示されるため、機能を利用していないタスクにも「Follow-up task creation was suppressed. disabled」が出る。

起点は `done-followups.ts` の `markTaskDoneAndQueueFollowups` が未使用 Run にも抑止要求を作ること。通常の OFF 操作を静かなままにし、ON の実行に対する明示的な抑止理由・過去の関連タスクは確認できるようにする。

## 再検証結果

- `bun test src/bun/migrate.test.ts src/bun/done-followups.test.ts src/bun/done-followups-orchestrator.test.ts`: 29 成功、0 失敗、168 assertions。
- `bun test src/bun/headless-routes.test.ts`: 5 成功、0 失敗、22 assertions。sandbox 内では待受失敗が `EADDRINUSE` として報告されたが、ローカル待受を許可した隔離実行では成功した。
- `bun run typecheck`: 成功。
- `bun run build:web`: 成功。Vite の既存 config／chunk size warning のみ。
- P2 再現: 専用の一時 SQLite DB を使用。CLI 起動なし。

上記は Bun `/tmp/kaname-bun/node_modules/.bin/bun` と開発用コピーの依存関係で実行した。DB を用いる試験はそれぞれ専用の一時データディレクトリを使い、実サービスのデータを変更していない。

実ブラウザー検証も再試行したが、成功確認には至らなかった。既存の実行設定では sandbox 内の Vite 起動に失敗し、待受許可後は 5173 番ポートの競合があった。別ポートを使う `/tmp` 内だけの検証設定では Vite の起動確認が 60 秒でタイムアウトした。定義 3 件の収集は成功したが、ブラウザーのテスト本体は 0 件実行であり、合格とは扱わない。この失敗だけで本機能の不具合とは判断しない。テスト用の起動処理は終了済み。

実 Codex／Claude の本機能の成功確認は、元の実装記録と同じく未完了。追加レビューでは実 CLI を起動していない。

## 差し戻し時の確認事項

- P2 の操作列で 1 回だけ起票され、その後の再送で増えないこと。
- 一度も ON にしていない通常タスクでは、Done 後も機能の抑止表示が出ないこと。
- 既に起票したタスクの編集・削除、設定 OFF、古い Run の要求の自動回収で既存の防止条件が崩れないこと。
- 実ブラウザーの ON → Review → Done → Backlog と、両実 CLI の小さな一時タスクで候補収集を確認すること。

commit・push・PR 作成・マージ・remote／履歴変更は行っていない。外部通知・GitHub 書き込みの実サービス検証も行っていない。

## 対応結果（2026-09-30）

### P2 — 修正済み

`queueRequestInner` は、現在の Done 条件を通過した**新しい明示 Done 操作**に限り、同じ source Run の `suppressed` request を同じ ID のまま `pending`（候補 0 件なら `succeeded`）へ戻す。起動時 recovery は `suppressed` を対象外のままにした。候補／生成 link の一意性は維持される。

`a new eligible Done revives a prior OFF suppression exactly once` は、ON 成功 → OFF Done 抑止 → recovery 不復帰 → Review/ON → Done → 1 件生成 → processor／Done 再送でも増えない、を専用 SQLite DB で確認する。

### P3 — 修正済み

`markTaskDoneAndQueueFollowups` は、現在 ON、Run 開始時 ON、collection、既存 request のいずれもない場合に抑止 request を書かない。初期 OFF の通常 Done は静かに完了する一方、ON Run を後から OFF にした抑止、後から ON にした旧 Run の snapshot 抑止、既存監査履歴は残る。

`an initial OFF run stays silent when moved from Review to Done` は、初期 OFF Run の Done と再送後にも request 行・summary.request・Follow-up panel の起点になる collection がないことを確認する。

### 再検証

- `bun test src/bun/migrate.test.ts src/bun/done-followups.test.ts src/bun/done-followups-orchestrator.test.ts` — 31 pass、0 fail、190 assertions。
- `bun run typecheck` と `bun run build:web` — 成功（既存 Vite warning のみ）。
- Playwright の Done-followups 3 定義は収集成功。実ブラウザーは loopback bind の `EPERM` と Chromium 実体未導入で未実行。
- 実 Codex／Claude の隔離読み取りタスクも再試行したが、Codex は app-server の read-only filesystem error、Claude は API `unknown` retry のため成功未確認。fixture と自分の child process は cleanup 済み。
