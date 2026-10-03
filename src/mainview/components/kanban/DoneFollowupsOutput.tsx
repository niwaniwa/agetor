import type { DoneFollowupCandidateInput } from "../../../shared/done-followups-protocol.ts";

/** Read-only presentation of agent output. No task mutation is available here:
 * the persisted Follow-up tasks panel owns collection/materialization state. */
export function DoneFollowupsOutput({
  candidates,
  original,
}: {
  candidates: readonly DoneFollowupCandidateInput[];
  original: string;
}) {
  return (
    <section data-testid="done-followups-output" className="mt-2 rounded-md border border-border bg-muted/20 p-3 text-xs">
      <div className="font-medium">追加タスクの提案 · {candidates.length} 件</div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        実行ログに出力された提案です。候補の保存・起票状況は上部の「Follow-up tasks」で確認できます。
      </p>
      {candidates.length === 0 ? (
        <p className="mt-2">追加タスクの提案はありません。</p>
      ) : (
        <ol className="mt-2 space-y-2">
          {candidates.map((candidate, index) => (
            <li key={index} className="rounded-md border border-border bg-background/50 p-2">
              <div className="break-words font-medium">{index + 1}. {candidate.title}</div>
              <dl className="mt-1.5 space-y-1 text-[11px]">
                <dt className="font-medium">理由・根拠</dt>
                <dd className="whitespace-pre-wrap break-words text-muted-foreground">{candidate.rationale}</dd>
                <dt className="font-medium">実施内容</dt>
                <dd className="whitespace-pre-wrap break-words text-muted-foreground">{candidate.scope}</dd>
                <dt className="font-medium">合格条件</dt>
                <dd>
                  <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                    {candidate.acceptanceCriteria.map((criterion, criterionIndex) => (
                      <li key={criterionIndex} className="whitespace-pre-wrap break-words">{criterion}</li>
                    ))}
                  </ul>
                </dd>
              </dl>
            </li>
          ))}
        </ol>
      )}
      <details data-testid="done-followups-original" className="mt-2 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">元の出力を表示</summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">{original}</pre>
      </details>
    </section>
  );
}
