import {
  DONE_FOLLOWUPS_OPEN_TAG,
  DONE_FOLLOWUPS_CLOSE_TAG,
  parseDoneFollowups,
  type DoneFollowupCandidateInput,
} from "../../shared/done-followups-protocol.ts";
import type { Run, RunEvent } from "../../shared/types.ts";

export interface DoneFollowupsPreview {
  before: string;
  candidates: DoneFollowupCandidateInput[];
}

/** A log preview is not a persisted collection or permission to create tasks.
 * Only opt-in run snapshots may have one; never use the current task switch.
 * Check the entire loaded main stream so duplicate envelopes in separate
 * messages cannot be disguised as two successful previews. */
export function doneFollowupsPreviewRunIds(
  events: readonly Pick<RunEvent, "runId" | "stream" | "data" | "subagentId">[],
  runs: readonly Pick<Run, "id" | "doneFollowupsEnabled">[],
): ReadonlySet<string> {
  const outputs = new Map<string, string>();
  for (const run of runs) {
    if (run.doneFollowupsEnabled === true) outputs.set(run.id, "");
  }
  for (const event of events) {
    if (event.stream !== "assistant" || event.subagentId != null || !outputs.has(event.runId)) continue;
    outputs.set(event.runId, outputs.get(event.runId)! + event.data);
  }
  return new Set([...outputs].filter(([, output]) => parseDoneFollowups(output).ok).map(([id]) => id));
}

/** Render only a complete standalone final envelope. Quoted/indented/inline
 * examples and fenced code remain ordinary Markdown, as do invalid or
 * incomplete outputs. The server's strict parser remains the only authority
 * for collection; these additional checks change presentation only. */
export function doneFollowupsPreview(text: string): DoneFollowupsPreview | null {
  const parsed = parseDoneFollowups(text);
  if (!parsed.ok) return null;
  const open = text.indexOf(DONE_FOLLOWUPS_OPEN_TAG);
  const end = text.indexOf(DONE_FOLLOWUPS_CLOSE_TAG) + DONE_FOLLOWUPS_CLOSE_TAG.length;
  if ((open > 0 && text[open - 1] !== "\n") || text.slice(end).trim() !== "") return null;

  let fence: { marker: string; length: number } | null = null;
  for (const line of text.slice(0, open).split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    if (fence) {
      if (marker[0] === fence.marker && marker.length >= fence.length && match[2]!.trim() === "") fence = null;
    } else if (marker[0] !== "`" || !match[2]!.includes("`")) {
      fence = { marker: marker[0]!, length: marker.length };
    }
  }
  if (fence) return null;
  return { before: text.slice(0, open), candidates: parsed.candidates };
}
