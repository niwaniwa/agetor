import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Run, Task } from "../shared/types.ts";

// db.ts captures this at module evaluation.  Set it before either dynamic
// import so this test never writes to a user's normal data directory.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-done-followups-"));

const { db, runs, tasks } = await import("./db.ts");
const {
  DONE_FOLLOWUPS_CLOSE_TAG,
  DONE_FOLLOWUPS_OPEN_TAG,
  appendDoneFollowupsPrompt,
  collectDoneFollowupsForRun,
  getDoneFollowupRequestForRun,
  getDoneFollowupSummary,
  markTaskDoneAndQueueFollowups,
  parseDoneFollowups,
  processDoneFollowupRequest,
  recoverDoneFollowupRequests,
  retryDoneFollowupRequest,
} = await import("./done-followups.ts");

const sourceTaskIds: string[] = [];
const runIds: string[] = [];

function sqlPlaceholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

afterEach(() => {
  if (sourceTaskIds.length === 0) return;
  const sources = sourceTaskIds.splice(0);
  const generated = sources.flatMap((sourceTaskId) => db.query<{ generated_task_id: string }, [string]>(
    "SELECT generated_task_id FROM done_followup_generated_tasks WHERE source_task_id = ?",
  ).all(sourceTaskId).map((row) => row.generated_task_id));
  const allTaskIds = [...new Set([...sources, ...generated])];
  const runsForCleanup = runIds.splice(0);

  db.transaction(() => {
    const sourceMarks = sqlPlaceholders(sources);
    const taskMarks = sqlPlaceholders(allTaskIds);
    if (runsForCleanup.length > 0) {
      const runMarks = sqlPlaceholders(runsForCleanup);
      db.run(`DELETE FROM done_followup_candidates WHERE run_id IN (${runMarks})`, runsForCleanup);
      db.run(`DELETE FROM done_followup_collections WHERE run_id IN (${runMarks})`, runsForCleanup);
      db.run(`DELETE FROM run_events WHERE run_id IN (${runMarks})`, runsForCleanup);
      db.run(`DELETE FROM runs WHERE id IN (${runMarks})`, runsForCleanup);
    }
    db.run(
      `DELETE FROM done_followup_generated_tasks
       WHERE source_task_id IN (${sourceMarks}) OR generated_task_id IN (${taskMarks})`,
      [...sources, ...allTaskIds],
    );
    db.run(`DELETE FROM done_followup_requests WHERE source_task_id IN (${sourceMarks})`, sources);
    db.run(`DELETE FROM tasks WHERE id IN (${taskMarks})`, allTaskIds);
  })();
});

function envelope(candidates: unknown[]): string {
  return DONE_FOLLOWUPS_OPEN_TAG + JSON.stringify({ candidates }) + DONE_FOLLOWUPS_CLOSE_TAG;
}

function candidate(title = "Add concise release notes") {
  return {
    title,
    rationale: "The implementation exposes a user-visible behavior worth documenting.",
    scope: "Document the behavior and add a focused regression test.",
    acceptanceCriteria: ["The release notes mention the behavior."],
  };
}

function makeSource(options: {
  output?: string;
  agent?: string;
  runAgent?: string;
  snapshot?: boolean;
  status?: Run["status"];
  doneFollowupsEnabled?: boolean;
} = {}): { task: Task; run: Run } {
  const now = Date.now();
  const taskId = `done-followups-source-${randomUUID()}`;
  const runId = `done-followups-run-${randomUUID()}`;
  const status = options.status ?? "succeeded";
  const task = tasks.insert({
    id: taskId,
    title: "Source task",
    prompt: "Implement the source task.",
    column: "review",
    agent: options.agent ?? "codex",
    workdir: "/tmp/done-followups-source-workdir",
    isolation: "worktree",
    taskType: "task",
    branch: "source-branch",
    branchSource: "created",
    worktreePath: "/tmp/volatile-source-worktree",
    baseRef: "source-base-ref",
    prUrl: "https://example.invalid/source-pr",
    issueUrl: null,
    mode: "auto",
    model: "gpt-test",
    effort: "high",
    fast: true,
    maxMode: true,
    doneFollowupsEnabled: options.doneFollowupsEnabled ?? true,
    references: [],
    backlog: [],
    draft: null,
    plans: [],
    runId,
    hasOpenableRun: false,
    pendingInteractionCount: 0,
    openTerminalCount: 0,
    todoProgress: null,
    sentFiles: null,
    fxRecovery: null,
    agentProfileId: null,
    agentProfile: null,
    pipelineId: null,
    pipelineRun: null,
    pipelineParentId: null,
    pipelineStepId: null,
    unread: false,
    hasAssistantMessages: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  const run = runs.insert({
    id: runId,
    taskId,
    agent: options.runAgent ?? "codex",
    status,
    startedAt: now - 100,
    endedAt: status === "running" ? null : now,
    exitCode: status === "succeeded" ? 0 : null,
    tmuxSession: null,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    geminiSessionId: null,
    fxSessionId: null,
    doneFollowupsEnabled: options.snapshot ?? true,
  });
  sourceTaskIds.push(taskId);
  runIds.push(runId);
  if (options.output !== undefined) runs.appendEvent(runId, "assistant", options.output);
  return { task, run };
}

test("strict protocol parser is all-or-nothing and prompt injection is idempotent", () => {
  const valid = envelope([candidate()]);
  const parsed = parseDoneFollowups(valid);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.candidates).toHaveLength(1);

  expect(parseDoneFollowups(envelope([candidate(), candidate("two"), candidate("three"), candidate("four"), candidate("five"), candidate("six")]))).toMatchObject({ ok: false });
  expect(parseDoneFollowups(valid + valid)).toMatchObject({ ok: false });
  expect(parseDoneFollowups(envelope([{ ...candidate(), acceptanceCriteria: [] }]))).toMatchObject({ ok: false });

  const prompted = appendDoneFollowupsPrompt("Do the task.");
  expect(prompted).toContain(DONE_FOLLOWUPS_OPEN_TAG);
  expect(appendDoneFollowupsPrompt(prompted)).toBe(prompted);
});

test("Done creates exactly one ordinary Backlog task and preserves both links", () => {
  const { task, run } = makeSource({ output: envelope([candidate()]) });
  const collected = collectDoneFollowupsForRun({ runId: run.id });
  expect(collected).toMatchObject({ ok: true, existing: false });
  if (!collected.ok) throw new Error("collection should have succeeded");
  expect(collected.collection.candidates).toHaveLength(1);

  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(marked.status).toBe("queued");
  if (marked.status !== "queued") throw new Error("expected a queued request");

  const processed = processDoneFollowupRequest({ requestId: marked.request.id });
  expect(processed.status).toBe("succeeded");
  if (processed.status !== "succeeded") throw new Error("expected generated task");
  expect(processed.generated).toHaveLength(1);

  const generated = tasks.get(processed.generated[0]!.generatedTaskId)!;
  expect(generated.column).toBe("backlog");
  expect(generated.doneFollowupsEnabled).toBe(false);
  expect(generated.runId).toBeNull();
  expect(generated.workdir).toBe(task.workdir);
  expect(generated.worktreePath).toBeNull();
  expect(generated.branch).toBeNull();
  expect(generated.baseRef).toBeNull();
  expect(generated.prUrl).toBeNull();
  expect(generated.pipelineId).toBeNull();
  expect(generated.agentProfileId).toBeNull();
  expect(generated.prompt).toContain("source task being Done does not mean its changes are merged");

  const sourceSummary = getDoneFollowupSummary(task.id)!;
  expect(sourceSummary.generated).toHaveLength(1);
  expect(sourceSummary.collection?.candidates[0]?.generatedTaskId).toBe(generated.id);
  const generatedSummary = getDoneFollowupSummary(generated.id)!;
  expect(generatedSummary.sources).toEqual(sourceSummary.generated);

  expect(processDoneFollowupRequest({ requestId: marked.request.id }).status).toBe("already-succeeded");
  expect(getDoneFollowupRequestForRun(run.id)?.status).toBe("succeeded");
});

test("a current OFF switch suppresses queueing but still moves the source to Done", () => {
  const { task, run } = makeSource({ output: envelope([candidate()]) });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });
  tasks.update(task.id, { doneFollowupsEnabled: false });

  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(marked).toMatchObject({ status: "done-without-followups", reason: "disabled" });
  expect(tasks.get(task.id)?.column).toBe("done");
  expect(getDoneFollowupRequestForRun(run.id)).toMatchObject({
    status: "suppressed",
    error: "disabled",
  });
  expect(getDoneFollowupSummary(task.id)?.request).toMatchObject({
    status: "suppressed",
    error: "disabled",
  });
});

test("an initial OFF run stays silent when moved from Review to Done", () => {
  const { task, run } = makeSource({
    output: "Ordinary completion without a follow-up envelope.",
    doneFollowupsEnabled: false,
    snapshot: false,
  });

  const firstDone = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(firstDone).toMatchObject({ status: "done-without-followups", reason: "disabled" });
  expect(firstDone).not.toHaveProperty("request");
  expect(tasks.get(task.id)?.column).toBe("done");

  // A duplicate Done remains an ordinary task transition and never creates a
  // stale suppressed row that would surface a follow-up panel in the UI.
  const secondDone = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(secondDone).toMatchObject({ status: "done-without-followups", reason: "disabled" });
  expect(secondDone).not.toHaveProperty("request");
  expect(getDoneFollowupRequestForRun(run.id)).toBeNull();
  expect(getDoneFollowupSummary(task.id)).toMatchObject({
    enabled: false,
    collection: null,
    request: null,
    generated: [],
  });
});

test("a new eligible Done revives a prior OFF suppression exactly once", () => {
  const { task, run } = makeSource({ output: envelope([candidate("Revive an explicitly suppressed follow-up")]) });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });

  // A human first decides not to create follow-ups. This durable suppression
  // must not be picked up by ordinary boot recovery.
  tasks.update(task.id, { doneFollowupsEnabled: false });
  expect(markTaskDoneAndQueueFollowups({ taskId: task.id })).toMatchObject({
    status: "done-without-followups",
    reason: "disabled",
  });
  const suppressed = getDoneFollowupRequestForRun(run.id);
  expect(suppressed).toMatchObject({ status: "suppressed", error: "disabled" });
  if (!suppressed) throw new Error("expected a durable suppression request");
  expect(getDoneFollowupSummary(task.id)?.generated).toHaveLength(0);
  expect(recoverDoneFollowupRequests()).toEqual([]);
  expect(getDoneFollowupRequestForRun(run.id)?.status).toBe("suppressed");

  // Moving back to Review and enabling the setting is a new human decision.
  // It may revive this one request, but it must reuse the stored candidates.
  tasks.update(task.id, { column: "review", doneFollowupsEnabled: true });
  const revived = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(revived.status).toBe("queued");
  if (revived.status !== "queued") throw new Error("expected revived queued request");
  expect(revived.request.id).toBe(suppressed.id);
  expect(revived.request).toMatchObject({ status: "pending", error: null });

  expect(processDoneFollowupRequest({ requestId: revived.request.id })).toMatchObject({ status: "succeeded" });
  expect(getDoneFollowupSummary(task.id)?.generated).toHaveLength(1);

  // A duplicate processor call and a later Done submission both see the same
  // materialized request; neither can create a second Backlog task.
  expect(processDoneFollowupRequest({ requestId: revived.request.id }).status).toBe("already-succeeded");
  expect(markTaskDoneAndQueueFollowups({ taskId: task.id }).status).toBe("already-materialized");
  const summary = getDoneFollowupSummary(task.id)!;
  expect(summary.generated).toHaveLength(1);
  expect(summary.collection?.candidates.filter((item) => item.generatedTaskId !== null)).toHaveLength(1);
});

test("an explicit zero-candidate envelope is a successful no-op at Done", () => {
  const { task, run } = makeSource({ output: envelope([]) });
  const collected = collectDoneFollowupsForRun({ runId: run.id });
  expect(collected).toMatchObject({ ok: true });
  if (!collected.ok) throw new Error("zero collection should succeed");
  expect(collected.collection.status).toBe("collected");
  expect(collected.collection.candidates).toHaveLength(0);

  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(marked.status).toBe("no-candidates");
  expect(tasks.get(task.id)?.column).toBe("done");
  expect(getDoneFollowupRequestForRun(run.id)).toMatchObject({ status: "succeeded" });
  expect(getDoneFollowupSummary(task.id)?.generated).toHaveLength(0);
});

test("missing, malformed, and over-limit envelopes fail collection without inference", () => {
  const invalidOutputs = [
    "Completed without a follow-up envelope.",
    `${DONE_FOLLOWUPS_OPEN_TAG}{not-json}${DONE_FOLLOWUPS_CLOSE_TAG}`,
    envelope([candidate("one"), candidate("two"), candidate("three"), candidate("four"), candidate("five"), candidate("six")]),
  ];

  for (const output of invalidOutputs) {
    const { task, run } = makeSource({ output });
    const collected = collectDoneFollowupsForRun({ runId: run.id });
    expect(collected).toMatchObject({ ok: true });
    if (!collected.ok) throw new Error("protocol failure should be persisted as a collection");
    expect(collected.collection).toMatchObject({ status: "failed" });
    expect(collected.collection.candidates).toHaveLength(0);

    const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
    expect(marked).toMatchObject({ status: "done-without-followups", reason: "collection-failed" });
    expect(getDoneFollowupRequestForRun(run.id)).toMatchObject({
      status: "suppressed",
      error: "collection-failed",
    });
    expect(getDoneFollowupSummary(task.id)?.generated).toHaveLength(0);
  }
});

test("the launch snapshot prevents retroactive opt-in, and pending work suppresses creation", () => {
  // Current ON cannot recover an older run that started while the switch was
  // OFF: no extra CLI and no historical inference are allowed.
  const oldOff = makeSource({
    output: envelope([candidate("Must not be inferred from an old OFF run")]),
    snapshot: false,
    doneFollowupsEnabled: true,
  });
  expect(collectDoneFollowupsForRun({ runId: oldOff.run.id })).toMatchObject({
    ok: false,
    reason: "run-snapshot-disabled",
  });
  expect(markTaskDoneAndQueueFollowups({ taskId: oldOff.task.id })).toMatchObject({
    status: "done-without-followups",
    reason: "run-snapshot-disabled",
  });
  expect(getDoneFollowupRequestForRun(oldOff.run.id)).toMatchObject({
    status: "suppressed",
    error: "run-snapshot-disabled",
  });

  const pending = makeSource({ output: envelope([candidate("Must wait for pending work")]) });
  expect(collectDoneFollowupsForRun({ runId: pending.run.id })).toMatchObject({ ok: true });
  expect(markTaskDoneAndQueueFollowups({
    taskId: pending.task.id,
    hasPendingWork: () => true,
  })).toMatchObject({
    status: "done-without-followups",
    reason: "pending-work",
  });
  expect(getDoneFollowupRequestForRun(pending.run.id)).toMatchObject({
    status: "suppressed",
    error: "pending-work",
  });
});

test("a queued request keeps its actual current-state suppression reason", () => {
  const { task, run } = makeSource({ output: envelope([candidate()]) });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });
  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  if (marked.status !== "queued") throw new Error("expected a queued request");
  tasks.update(task.id, { doneFollowupsEnabled: false });

  expect(processDoneFollowupRequest({ requestId: marked.request.id })).toMatchObject({
    status: "suppressed",
    reason: "disabled",
  });
  // The durable status remains meaningful when a recovery/API caller reads it
  // again later instead of degrading every suppression to a stale-run claim.
  expect(processDoneFollowupRequest({ requestId: marked.request.id })).toMatchObject({
    status: "suppressed",
    reason: "disabled",
  });
  expect(getDoneFollowupRequestForRun(run.id)?.error).toBe("disabled");
});

test("work that becomes pending after Done is durably suppressed", () => {
  const { task, run } = makeSource({ output: envelope([candidate("Must not race pending work")]) });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });
  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  if (marked.status !== "queued") throw new Error("expected a queued request");

  expect(processDoneFollowupRequest({
    requestId: marked.request.id,
    hasPendingWork: () => true,
  })).toMatchObject({
    status: "suppressed",
    reason: "pending-work",
  });
  expect(getDoneFollowupRequestForRun(run.id)).toMatchObject({
    status: "suppressed",
    error: "pending-work",
  });
});

test("a failed atomic materialization preserves candidates and retries without a CLI", () => {
  const secondTitle = "Injected second follow-up failure";
  const { task, run } = makeSource({
    output: envelope([candidate("First atomic follow-up"), candidate(secondTitle)]),
  });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });
  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  if (marked.status !== "queued") throw new Error("expected a queued request");

  // Make the second INSERT abort. The first candidate's task/link must roll
  // back with it; a later explicit retry uses the same stored candidates.
  const triggerName = `done_followups_test_abort_${randomUUID().replaceAll("-", "")}`;
  db.run(
    `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON tasks
     WHEN NEW.title = '${secondTitle}'
     BEGIN SELECT RAISE(ABORT, 'injected follow-up materialization failure'); END`,
  );
  try {
    const failed = processDoneFollowupRequest({ requestId: marked.request.id });
    expect(failed).toMatchObject({ status: "failed" });
    expect(getDoneFollowupSummary(task.id)?.generated).toHaveLength(0);
    expect(getDoneFollowupSummary(task.id)?.collection?.candidates.every((item) => item.generatedTaskId === null)).toBe(true);
    expect(tasks.get(task.id)?.column).toBe("done");
    expect(getDoneFollowupRequestForRun(run.id)).toMatchObject({ status: "failed", attemptCount: 1 });
  } finally {
    db.run(`DROP TRIGGER IF EXISTS "${triggerName}"`);
  }

  const retried = retryDoneFollowupRequest(marked.request.id);
  expect(retried).toMatchObject({ status: "succeeded" });
  expect(getDoneFollowupSummary(task.id)?.generated).toHaveLength(2);
  expect(getDoneFollowupRequestForRun(run.id)).toMatchObject({ status: "succeeded", attemptCount: 2 });
});

test("replayed Done and processor calls materialize each candidate only once", () => {
  const { task, run } = makeSource({
    output: envelope([candidate("Concurrent one"), candidate("Concurrent two")]),
  });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });

  // Synchronous SQLite transactions serialize the equivalent of two browser
  // tabs reaching the service at once. The second registration sees the
  // first request rather than creating another source-run request.
  const firstDone = markTaskDoneAndQueueFollowups({ taskId: task.id });
  const secondDone = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(firstDone.status).toBe("queued");
  expect(secondDone.status).toBe("already-queued");
  if (firstDone.status !== "queued") throw new Error("expected first request");

  expect(processDoneFollowupRequest({ requestId: firstDone.request.id }).status).toBe("succeeded");
  expect(processDoneFollowupRequest({ requestId: firstDone.request.id }).status).toBe("already-succeeded");
  const summary = getDoneFollowupSummary(task.id)!;
  expect(summary.generated).toHaveLength(2);
  expect(summary.collection?.candidates.map((item) => item.generatedTaskId)).toHaveLength(2);
  expect(markTaskDoneAndQueueFollowups({ taskId: task.id }).status).toBe("already-materialized");
});

test("restart recovery rebuilds a missing collection from persisted assistant chunks", () => {
  const output = envelope([candidate("Recover a durable candidate")]);
  const { run } = makeSource();
  const middle = Math.floor(output.length / 2);
  runs.appendEvent(run.id, "assistant", output.slice(0, middle));
  runs.appendEvent(run.id, "assistant", output.slice(middle));

  expect(recoverDoneFollowupRequests()).toEqual([]);
  const summary = getDoneFollowupSummary(run.taskId)!;
  expect(summary.collection).toMatchObject({ status: "collected" });
  expect(summary.collection?.candidates.map((item) => item.title)).toEqual(["Recover a durable candidate"]);
});

test("restart recovery replays a saved pending request once without a new CLI", () => {
  const { task, run } = makeSource({ output: envelope([candidate("Recover pending creation")]) });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });
  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  if (marked.status !== "queued") throw new Error("expected durable pending request");

  const recovered = recoverDoneFollowupRequests();
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ status: "succeeded" });
  expect(getDoneFollowupRequestForRun(run.id)).toMatchObject({ status: "succeeded" });
  expect(getDoneFollowupSummary(task.id)?.generated).toHaveLength(1);
});

test("collection uses the frozen run agent and stale Done requests are suppressed", () => {
  // A user can PATCH task.agent while a run is live. Collection must honor
  // the actual harness that created this run, not the later mutable field.
  const { task, run } = makeSource({
    agent: "an-unrelated-agent-after-start",
    runAgent: "codex",
    output: envelope([candidate("Frozen harness candidate")]),
  });
  expect(collectDoneFollowupsForRun({ runId: run.id })).toMatchObject({ ok: true });
  const marked = markTaskDoneAndQueueFollowups({ taskId: task.id });
  expect(marked.status).toBe("queued");
  if (marked.status !== "queued") throw new Error("expected a queued request");

  const newerRunId = `done-followups-run-${randomUUID()}`;
  const now = Date.now();
  runs.insert({
    ...run,
    id: newerRunId,
    status: "failed",
    startedAt: now,
    endedAt: now,
    exitCode: 1,
    doneFollowupsEnabled: false,
  });
  runIds.push(newerRunId);
  tasks.update(task.id, { runId: newerRunId });

  expect(processDoneFollowupRequest({ requestId: marked.request.id })).toMatchObject({
    status: "suppressed",
    reason: "latest-run-changed",
  });
});
