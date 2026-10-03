import { expect, test } from "bun:test";
import { doneFollowupsPreview, doneFollowupsPreviewRunIds } from "./done-followups-preview.ts";
import type { RunEvent } from "../../shared/types.ts";
import { parseDoneFollowups } from "../../shared/done-followups-protocol.ts";

const candidate = {
  title: "次の改善",
  rationale: "調査で分かった理由",
  scope: "独立した変更",
  acceptanceCriteria: ["期待する結果"],
};
const envelope = (candidates: unknown[] = [candidate]) => `<kaname-followups>${JSON.stringify({ candidates })}</kaname-followups>`;
const event = (data: string, extra: Partial<RunEvent> = {}): RunEvent => ({ runId: "enabled", taskId: "task", stream: "assistant", data, ts: 0, ...extra });
const runs = [{ id: "enabled", doneFollowupsEnabled: true }, { id: "disabled", doneFollowupsEnabled: false }];

test("a complete final envelope displays all candidate fields and retains preceding prose", () => {
  const before = "# 完了\n\n本文を維持します。\n\n";
  expect(doneFollowupsPreview(before + envelope())).toEqual({ before, candidates: [candidate] });
  expect(doneFollowupsPreview(envelope([]))).toEqual({ before: "", candidates: [] });
  expect(doneFollowupsPreview(envelope() + "\n \n")).not.toBeNull();
});

test("malformed, partial, duplicate, missing, and over-limit output cannot become a preview", () => {
  for (const text of [
    "Plain text",
    "<kaname-followups>{\"candidates\":[]}",
    "<kaname-followups>not JSON</kaname-followups>",
    "<kaname-followups>{\"candidates\":[],\"extra\":true}</kaname-followups>",
    envelope([{ ...candidate, acceptanceCriteria: [] }]),
    envelope([{ ...candidate, scope: " " }]),
    envelope([{ ...candidate, target: "ready" }]),
    envelope(Array.from({ length: 6 }, () => candidate)),
    envelope() + "\n" + envelope(),
  ]) {
    expect(doneFollowupsPreview(text)).toBeNull();
    expect(parseDoneFollowups(text).ok).toBe(false);
  }
});

test("inline, quoted, indented, and fenced examples stay as Markdown", () => {
  for (const text of [
    `An example: ${envelope()}`,
    `> ${envelope()}`,
    `    ${envelope()}`,
    `\t${envelope()}`,
    `\`${envelope()}\``,
    `\`\`\`xml\n${envelope()}\n\`\`\``,
    `~~~json\n${envelope()}`,
    `\`\`\`\`xml\n\`\`\`\n${envelope()}`,
    envelope() + "\nThis was an example.",
  ]) expect(doneFollowupsPreview(text)).toBeNull();
  expect(doneFollowupsPreview(`\`\`\`ts\nconst x = 1;\n\`\`\`\n\n${envelope()}`)).not.toBeNull();
});

test("only the immutable opt-in main run snapshot enables a preview", () => {
  const events = [event(envelope()), event(envelope(), { runId: "disabled" }), event(envelope(), { runId: "unknown" })];
  expect([...doneFollowupsPreviewRunIds(events, runs)]).toEqual(["enabled"]);
  expect([...doneFollowupsPreviewRunIds([event(envelope(), { subagentId: "sub" })], runs)]).toEqual([]);
  expect([...doneFollowupsPreviewRunIds([event(envelope(), { stream: "user" })], runs)]).toEqual([]);
  expect([...doneFollowupsPreviewRunIds([event(envelope())], [{ id: "enabled" }])]).toEqual([]);
});

test("duplicate envelopes across messages remain unformatted and subagent envelopes do not interfere", () => {
  expect([...doneFollowupsPreviewRunIds([event(envelope()), event(envelope())], runs)]).toEqual([]);
  expect([...doneFollowupsPreviewRunIds([event(envelope()), event(envelope(), { subagentId: "sub" })], runs)]).toEqual(["enabled"]);
});

test("streaming chunks never infer a preview before the complete valid envelope exists", () => {
  const text = envelope();
  const opening = text.slice(0, 35);
  const rest = text.slice(35);
  expect([...doneFollowupsPreviewRunIds([event(opening)], runs)]).toEqual([]);
  expect([...doneFollowupsPreviewRunIds([event(opening), event(rest)], runs)]).toEqual(["enabled"]);
  // Keep individually incomplete messages raw. Never invent boundaries or
  // rewrite the durable event stream to repair a display-only preview.
  expect(doneFollowupsPreview(opening)).toBeNull();
  expect(doneFollowupsPreview(rest)).toBeNull();
});
