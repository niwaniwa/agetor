/**
 * Protocol and durable persistence for Done-time follow-up tasks.
 *
 * This intentionally has no orchestrator, HTTP-server, or UI import. Those
 * layers own live CLI state; this layer owns restart-safe data and atomic
 * task creation only.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentKind,
  DoneFollowupCandidate,
  DoneFollowupCollection,
  DoneFollowupGeneratedLink,
  DoneFollowupRequest,
  DoneFollowupSummary,
  Run,
  Task,
} from "../shared/types.ts";
import { db, runs, tasks } from "./db.ts";

import {
  DONE_FOLLOWUPS_OPEN_TAG,
  DONE_FOLLOWUPS_CLOSE_TAG,
  parseDoneFollowups,
} from "../shared/done-followups-protocol.ts";
export {
  DONE_FOLLOWUPS_MAX_CANDIDATES,
  DONE_FOLLOWUPS_OPEN_TAG,
  DONE_FOLLOWUPS_CLOSE_TAG,
  parseDoneFollowups,
  type DoneFollowupCandidateInput,
  type DoneFollowupParseResult,
} from "../shared/done-followups-protocol.ts";

export const DONE_FOLLOWUPS_PROMPT_MARKER = "<!-- kaname-done-followups:v1 -->";

export type DoneFollowupEligibilityReason =
  | "pipeline-task"
  | "pipeline-step"
  | "unsupported-agent"
  | "disabled"
  | "no-latest-run"
  | "run-not-succeeded"
  | "run-snapshot-disabled"
  | "pending-work"
  | "collection-failed"
  | "collection-missing"
  | "source-not-done"
  | "source-archived"
  | "source-task-missing"
  | "latest-run-changed";

export type DoneFollowupEligibility =
  | { ok: true; kind: "claude-code" | "codex" }
  | { ok: false; reason: DoneFollowupEligibilityReason };

export interface DoneFollowupRuntime {
  /** Resolve aliases to a concrete kind. Built-in ids work without this. */
  resolveAgentKind?: (task: Task) => AgentKind | null | undefined;
  /**
   * True only for a real live input/queue/background execution. Drafts and
   * the saved-message backlog are explicitly not pending work.
   */
  hasPendingWork?: (task: Task, run: Run) => boolean;
}

export interface CollectDoneFollowupsInput extends DoneFollowupRuntime {
  runId: string;
  /** Omit to parse the durable top-level assistant-event stream. */
  output?: string;
  now?: number;
}

export type CollectDoneFollowupsResult =
  | { ok: true; collection: DoneFollowupCollection; existing: boolean }
  | { ok: false; reason: DoneFollowupEligibilityReason | "run-missing" };

export interface MarkTaskDoneAndQueueFollowupsInput extends DoneFollowupRuntime {
  taskId: string;
  /** Sanitized caller patch, applied atomically with column="done". */
  beforeDonePatch?: Partial<Task>;
  now?: number;
}

export type MarkTaskDoneAndQueueFollowupsResult =
  | {
    status: "queued" | "already-queued" | "already-materialized" | "no-candidates";
    task: Task;
    request: DoneFollowupRequest;
    collection: DoneFollowupCollection;
  }
  | {
    status: "done-without-followups";
    task: Task;
    reason: DoneFollowupEligibilityReason;
    collection?: DoneFollowupCollection | null;
    /**
     * A source run existed, but current Done-time validation suppressed its
     * materialization. Persist this once so a later summary can explain why
     * the human's Done action did not create anything.
     */
    request?: DoneFollowupRequest;
  }
  | { status: "not-found" };

export interface ProcessDoneFollowupRequestInput extends DoneFollowupRuntime {
  requestId: string;
  /** Failed requests require an explicit retry. */
  retry?: boolean;
  /** Allows boot recovery to reclaim a legacy processing row. */
  recovery?: boolean;
  now?: number;
}

export type ProcessDoneFollowupRequestResult =
  | {
    status: "succeeded" | "already-succeeded";
    request: DoneFollowupRequest;
    generated: DoneFollowupGeneratedLink[];
  }
  | { status: "deferred"; request: DoneFollowupRequest; reason: "pending-work" }
  | {
    status: "suppressed";
    request: DoneFollowupRequest;
    reason: DoneFollowupEligibilityReason;
  }
  | { status: "failed"; request: DoneFollowupRequest; error: string }
  | { status: "needs-retry"; request: DoneFollowupRequest }
  | { status: "not-found" };

type CollectionRow = {
  run_id: string;
  source_task_id: string;
  enabled: number;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

type CandidateRow = {
  id: string;
  run_id: string;
  ordinal: number;
  title: string;
  rationale: string;
  scope: string;
  acceptance_criteria: string;
  created_at: number;
  generated_task_id: string | null;
};

type RequestRow = {
  id: string;
  source_task_id: string;
  source_run_id: string;
  status: string;
  error: string | null;
  attempt_count: number;
  created_at: number;
  updated_at: number;
};

type GeneratedRow = {
  candidate_id: string;
  request_id: string;
  source_task_id: string;
  source_run_id: string;
  generated_task_id: string;
  created_at: number;
};

const REQUEST_STATUSES = new Set<DoneFollowupRequest["status"]>([
  "pending", "processing", "succeeded", "failed", "suppressed",
]);

const ELIGIBILITY_REASONS = new Set<DoneFollowupEligibilityReason>([
  "pipeline-task",
  "pipeline-step",
  "unsupported-agent",
  "disabled",
  "no-latest-run",
  "run-not-succeeded",
  "run-snapshot-disabled",
  "pending-work",
  "collection-failed",
  "collection-missing",
  "source-not-done",
  "source-archived",
  "source-task-missing",
  "latest-run-changed",
]);

function transact<T>(fn: () => T): T {
  return db.transaction(fn)();
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Idempotently appends the text-only protocol. */
export function appendDoneFollowupsPrompt(prompt: string): string {
  if (prompt.includes(DONE_FOLLOWUPS_PROMPT_MARKER)) return prompt;
  return prompt.trimEnd()
    + "\n\n"
    + DONE_FOLLOWUPS_PROMPT_MARKER
    + "\n\nWhen you finish, identify only independent follow-up work discovered during this task. "
    + "Do not move an unmet required condition, failing test, or required fix into a follow-up. "
    + "Output exactly one final JSON envelope, including when there are no candidates:\n"
    + DONE_FOLLOWUPS_OPEN_TAG
    + "{\"candidates\":[{\"title\":\"...\",\"rationale\":\"...\",\"scope\":\"...\",\"acceptanceCriteria\":[\"...\"]}]}"
    + DONE_FOLLOWUPS_CLOSE_TAG
    + "\nReturn 0 to 5 candidates. Every field must be non-empty and acceptanceCriteria must contain at least one non-empty string. "
    + "The envelope is data only: do not propose task settings, paths, Ready state, API calls, Git operations, or notifications.";
}

function inferredKind(task: Task, runtime?: DoneFollowupRuntime): AgentKind | null {
  const resolved = runtime?.resolveAgentKind?.(task);
  if (resolved) return resolved;
  return task.agent === "claude-code" || task.agent === "codex" ? task.agent : null;
}

/** A run's harness is frozen at launch.  Feed that id through the same
 * resolver (using a task-shaped value for its existing callback contract) so
 * a later PATCH of task.agent cannot turn a historical Codex/Claude run into
 * an ineligible one, or vice versa. */
function inferredRunKind(task: Task, run: Run, runtime?: DoneFollowupRuntime): AgentKind | null {
  return inferredKind(task.agent === run.agent ? task : { ...task, agent: run.agent }, runtime);
}

/**
 * Static policy check. Collection intentionally passes requireEnabled:false:
 * a run snapshot remains collectable after the current task switch is turned
 * off, while Done-time queueing requires both values to be on.
 */
export function isDoneFollowupsEligible(
  task: Pick<Task, "agent" | "pipelineId" | "pipelineParentId" | "doneFollowupsEnabled">,
  agentKind?: AgentKind | null,
  opts: { requireEnabled?: boolean } = {},
): DoneFollowupEligibility {
  if (task.pipelineParentId != null) return { ok: false, reason: "pipeline-step" };
  if (task.pipelineId != null) return { ok: false, reason: "pipeline-task" };
  const kind = agentKind ?? (task.agent === "claude-code" || task.agent === "codex" ? task.agent : null);
  if (kind !== "claude-code" && kind !== "codex") return { ok: false, reason: "unsupported-agent" };
  if (opts.requireEnabled !== false && task.doneFollowupsEnabled !== true) {
    return { ok: false, reason: "disabled" };
  }
  return { ok: true, kind };
}

/** Restart-safe reassembly of top-level assistant output. */
export function persistedAssistantOutputForRun(runId: string): string {
  return runs.events(runId)
    .filter((event) => event.stream === "assistant" && event.subagentId == null)
    .map((event) => event.data)
    .join("");
}

function parseCriteria(raw: string): string[] {
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    const values = decoded.map(nonBlankString);
    return values.every((value) => value !== null) ? values as string[] : [];
  } catch {
    return [];
  }
}

function toGeneratedLink(row: GeneratedRow): DoneFollowupGeneratedLink {
  return {
    candidateId: row.candidate_id,
    requestId: row.request_id,
    sourceTaskId: row.source_task_id,
    sourceRunId: row.source_run_id,
    generatedTaskId: row.generated_task_id,
    createdAt: row.created_at,
  };
}

function generatedLinksForRun(runId: string): Map<string, DoneFollowupGeneratedLink> {
  const rows = db.query<GeneratedRow, [string]>(
    "SELECT * FROM done_followup_generated_tasks WHERE source_run_id = ?",
  ).all(runId);
  return new Map(rows.map((row) => [row.candidate_id, toGeneratedLink(row)]));
}

function toCollection(row: CollectionRow): DoneFollowupCollection {
  const links = generatedLinksForRun(row.run_id);
  const candidates = db.query<CandidateRow, [string]>(
    "SELECT c.*, g.generated_task_id "
      + "FROM done_followup_candidates c "
      + "LEFT JOIN done_followup_generated_tasks g ON g.candidate_id = c.id "
      + "WHERE c.run_id = ? ORDER BY c.ordinal ASC",
  ).all(row.run_id).map((candidate) => ({
    id: candidate.id,
    runId: candidate.run_id,
    ordinal: candidate.ordinal,
    title: candidate.title,
    rationale: candidate.rationale,
    scope: candidate.scope,
    acceptanceCriteria: parseCriteria(candidate.acceptance_criteria),
    createdAt: candidate.created_at,
    generatedTaskId: links.get(candidate.id)?.generatedTaskId ?? null,
  }));
  return {
    runId: row.run_id,
    sourceTaskId: row.source_task_id,
    enabled: row.enabled === 1,
    status: row.status === "collected" ? "collected" : "failed",
    error: row.error,
    candidates,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRequest(row: RequestRow): DoneFollowupRequest {
  return {
    id: row.id,
    sourceTaskId: row.source_task_id,
    sourceRunId: row.source_run_id,
    status: REQUEST_STATUSES.has(row.status as DoneFollowupRequest["status"])
      ? row.status as DoneFollowupRequest["status"]
      : "failed",
    error: row.error,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getDoneFollowupCollection(runId: string): DoneFollowupCollection | null {
  const row = db.query<CollectionRow, [string]>(
    "SELECT * FROM done_followup_collections WHERE run_id = ?",
  ).get(runId);
  return row ? toCollection(row) : null;
}

export function getDoneFollowupRequest(requestId: string): DoneFollowupRequest | null {
  const row = db.query<RequestRow, [string]>(
    "SELECT * FROM done_followup_requests WHERE id = ?",
  ).get(requestId);
  return row ? toRequest(row) : null;
}

export function getDoneFollowupRequestForRun(runId: string): DoneFollowupRequest | null {
  const row = db.query<RequestRow, [string]>(
    "SELECT * FROM done_followup_requests WHERE source_run_id = ?",
  ).get(runId);
  return row ? toRequest(row) : null;
}

export function listGeneratedDoneFollowupsForSource(taskId: string): DoneFollowupGeneratedLink[] {
  return db.query<GeneratedRow, [string]>(
    "SELECT * FROM done_followup_generated_tasks "
      + "WHERE source_task_id = ? ORDER BY created_at ASC, candidate_id ASC",
  ).all(taskId).map(toGeneratedLink);
}

export function listDoneFollowupSourcesForGeneratedTask(taskId: string): DoneFollowupGeneratedLink[] {
  return db.query<GeneratedRow, [string]>(
    "SELECT * FROM done_followup_generated_tasks "
      + "WHERE generated_task_id = ? ORDER BY created_at ASC, candidate_id ASC",
  ).all(taskId).map(toGeneratedLink);
}

/**
 * Detail-ready data for a source task. Collection/request intentionally point
 * at the current latest run, while historical generated links remain visible.
 */
export function getDoneFollowupSummary(taskId: string): DoneFollowupSummary | null {
  const task = tasks.get(taskId);
  if (!task) return null;
  const latestRunId = task.runId;
  return {
    taskId,
    enabled: task.doneFollowupsEnabled === true,
    latestRunId,
    collection: latestRunId ? getDoneFollowupCollection(latestRunId) : null,
    request: latestRunId ? getDoneFollowupRequestForRun(latestRunId) : null,
    sources: listDoneFollowupSourcesForGeneratedTask(taskId),
    generated: listGeneratedDoneFollowupsForSource(taskId),
  };
}

function persistCollectionInner(input: CollectDoneFollowupsInput): CollectDoneFollowupsResult {
  const existing = getDoneFollowupCollection(input.runId);
  if (existing) return { ok: true, collection: existing, existing: true };

  const run = runs.get(input.runId);
  if (!run) return { ok: false, reason: "run-missing" };
  const task = tasks.get(run.taskId);
  if (!task) return { ok: false, reason: "source-task-missing" };
  const normal = isDoneFollowupsEligible(task, inferredRunKind(task, run, input), { requireEnabled: false });
  if (!normal.ok) return normal;
  if (run.status !== "succeeded") return { ok: false, reason: "run-not-succeeded" };
  if (run.doneFollowupsEnabled !== true) return { ok: false, reason: "run-snapshot-disabled" };

  const parsed = parseDoneFollowups(input.output ?? persistedAssistantOutputForRun(run.id));
  const now = input.now ?? Date.now();
  db.run(
    "INSERT INTO done_followup_collections "
      + "(run_id, source_task_id, enabled, status, error, created_at, updated_at) "
      + "VALUES (?, ?, 1, ?, ?, ?, ?)",
    [run.id, task.id, parsed.ok ? "collected" : "failed", parsed.ok ? null : parsed.error, now, now],
  );
  if (parsed.ok) {
    for (const [ordinal, candidate] of parsed.candidates.entries()) {
      db.run(
        "INSERT INTO done_followup_candidates "
          + "(id, run_id, ordinal, title, rationale, scope, acceptance_criteria, created_at) "
          + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          randomUUID(),
          run.id,
          ordinal,
          candidate.title,
          candidate.rationale,
          candidate.scope,
          JSON.stringify(candidate.acceptanceCriteria),
          now,
        ],
      );
    }
  }
  return { ok: true, collection: getDoneFollowupCollection(run.id)!, existing: false };
}

/**
 * Persist a successful snapshot-enabled run exactly once. A reattach or boot
 * recovery returns the original result instead of replacing it.
 */
export function collectDoneFollowupsForRun(input: CollectDoneFollowupsInput): CollectDoneFollowupsResult {
  return transact(() => persistCollectionInner(input));
}

function queueRequestInner(
  task: Task,
  run: Run,
  collection: DoneFollowupCollection,
  now: number,
): DoneFollowupRequest {
  const existing = getDoneFollowupRequestForRun(run.id);
  if (existing) {
    // Boot recovery intentionally never replays a suppressed request: its
    // original Done action was ineligible.  This helper is only reached from
    // a fresh, explicit Done action, after all current-state gates above have
    // passed.  Let that new human decision retry the same stored candidates
    // without allocating another request (or another candidate identity).
    if (existing.status === "suppressed") {
      const status: DoneFollowupRequest["status"] =
        collection.candidates.length === 0 ? "succeeded" : "pending";
      db.run(
        "UPDATE done_followup_requests SET status = ?, error = NULL, updated_at = ? WHERE id = ?",
        [status, now, existing.id],
      );
      return getDoneFollowupRequest(existing.id)!;
    }
    return existing;
  }
  const id = randomUUID();
  const status: DoneFollowupRequest["status"] =
    collection.candidates.length === 0 ? "succeeded" : "pending";
  db.run(
    "INSERT INTO done_followup_requests "
      + "(id, source_task_id, source_run_id, status, error, attempt_count, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, NULL, 0, ?, ?)",
    [id, task.id, run.id, status, now, now],
  );
  return getDoneFollowupRequest(id)!;
}

/**
 * A Done action can be valid as a column transition yet ineligible to create
 * tasks (for example the switch was turned OFF in Review, the newest run
 * failed, or real work is still pending). Preserve that outcome against the
 * concrete latest run when one exists. Automatic recovery never revisits a
 * suppressed row. A later explicit Done action may re-evaluate it only after
 * the current task/run gates pass, using the same request and candidates.
 */
function suppressRequestForRunInner(
  task: Task,
  run: Run,
  reason: DoneFollowupEligibilityReason,
  now: number,
): DoneFollowupRequest {
  const existing = getDoneFollowupRequestForRun(run.id);
  if (existing) return existing;
  const id = randomUUID();
  db.run(
    "INSERT INTO done_followup_requests "
      + "(id, source_task_id, source_run_id, status, error, attempt_count, created_at, updated_at) "
      + "VALUES (?, ?, ?, 'suppressed', ?, 0, ?, ?)",
    [id, task.id, run.id, reason, now, now],
  );
  return getDoneFollowupRequest(id)!;
}

/**
 * Atomic Done transition plus durable request registration. Failure to parse
 * the protocol never rolls Done back; it remains visible as a failed
 * collection and no task is inferred.
 */
export function markTaskDoneAndQueueFollowups(
  input: MarkTaskDoneAndQueueFollowupsInput,
): MarkTaskDoneAndQueueFollowupsResult {
  return transact(() => {
    const current = tasks.get(input.taskId);
    if (!current) return { status: "not-found" };
    if (current.archivedAt != null) {
      return { status: "done-without-followups", task: current, reason: "source-archived" };
    }

    const task = tasks.update(input.taskId, {
      ...(input.beforeDonePatch ?? {}),
      column: "done",
    });
    if (!task) return { status: "not-found" };
    if (!task.runId) return { status: "done-without-followups", task, reason: "no-latest-run" };
    const run = runs.get(task.runId);
    if (!run) return { status: "done-without-followups", task, reason: "no-latest-run" };
    const now = input.now ?? Date.now();
    const existingCollection = () => getDoneFollowupCollection(run.id);
    // A normal task that was OFF both at launch and at Done never opted into
    // this feature.  Its ordinary Done transition must stay silent: a
    // synthetic `suppressed / disabled` request would make the detail panel
    // imply that follow-up creation was attempted.  Keep a durable reason
    // whenever there is actual follow-up context, including a later ON on an
    // older OFF run and any existing collection/request audit history.
    const hasFollowupContext = (collection: DoneFollowupCollection | null) => (
      task.doneFollowupsEnabled === true
      || run.doneFollowupsEnabled === true
      || collection !== null
      || getDoneFollowupRequestForRun(run.id) !== null
    );
    const suppressed = (reason: DoneFollowupEligibilityReason, collection = existingCollection()) => {
      const request = hasFollowupContext(collection)
        ? suppressRequestForRunInner(task, run, reason, now)
        : undefined;
      return {
        status: "done-without-followups" as const,
        task,
        reason,
        collection,
        ...(request ? { request } : {}),
      };
    };

    const normal = isDoneFollowupsEligible(task, inferredRunKind(task, run, input));
    if (!normal.ok) return suppressed(normal.reason);
    if (run.status !== "succeeded") {
      return suppressed("run-not-succeeded");
    }
    if (run.doneFollowupsEnabled !== true) {
      return suppressed("run-snapshot-disabled");
    }
    if (input.hasPendingWork?.(task, run) === true) {
      return suppressed("pending-work");
    }

    const collected = persistCollectionInner({ ...input, runId: run.id });
    if (!collected.ok) {
      return suppressed(collected.reason === "run-missing" ? "no-latest-run" : collected.reason);
    }
    if (collected.collection.status !== "collected") {
      return suppressed("collection-failed", collected.collection);
    }

    const oldRequest = getDoneFollowupRequestForRun(run.id);
    const revivingSuppression = oldRequest?.status === "suppressed";
    const request = queueRequestInner(task, run, collected.collection, now);
    if (request.status === "succeeded") {
      return oldRequest && collected.collection.candidates.length > 0
        ? { status: "already-materialized", task, request, collection: collected.collection }
        : { status: "no-candidates", task, request, collection: collected.collection };
    }
    return {
      // A revived suppression uses the same durable request, but it is a new
      // explicit Done decision and must be handed to the materializer just
      // like an initially queued request.
      status: oldRequest && !revivingSuppression ? "already-queued" : "queued",
      task,
      request,
      collection: collected.collection,
    };
  });
}

function requestFailure(requestId: string, error: string, now: number): DoneFollowupRequest | null {
  return transact(() => {
    const request = getDoneFollowupRequest(requestId);
    if (!request || request.status === "succeeded") return request;
    db.run(
      "UPDATE done_followup_requests "
        + "SET status = 'failed', error = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
      [error, now, requestId],
    );
    return getDoneFollowupRequest(requestId);
  });
}

function suppressRequest(
  request: DoneFollowupRequest,
  reason: DoneFollowupEligibilityReason,
  now: number,
): DoneFollowupRequest {
  db.run(
    "UPDATE done_followup_requests SET status = 'suppressed', error = ?, updated_at = ? WHERE id = ?",
    [reason, now, request.id],
  );
  return getDoneFollowupRequest(request.id)!;
}

function storedSuppressionReason(request: DoneFollowupRequest): DoneFollowupEligibilityReason {
  return request.error !== null && ELIGIBILITY_REASONS.has(request.error as DoneFollowupEligibilityReason)
    ? request.error as DoneFollowupEligibilityReason
    : "latest-run-changed";
}

function generatedTaskPrompt(source: Task, candidate: DoneFollowupCandidate): string {
  const criteria = candidate.acceptanceCriteria.map((criterion) => "- " + criterion).join("\n");
  return "# Follow-up: " + candidate.title
    + "\n\n## Why this was identified\n" + candidate.rationale
    + "\n\n## Scope\n" + candidate.scope
    + "\n\n## Acceptance criteria\n" + criteria
    + "\n\n## Related source task\n"
    + "This independent follow-up was identified while working on \"" + source.title + "\" "
    + "(task " + source.id + ", run " + candidate.runId + ")."
    + "\n\nThe source task being Done does not mean its changes are merged. "
    + "If this work depends on the source result, inspect that prerequisite before starting.";
}

/**
 * An ordinary unstarted Backlog task. No profile/pipeline binding, worktree,
 * branch, PR, session, or baseRef leaks across the boundary; normal startup
 * will pin current HEAD and make any new worktree itself.
 */
function generatedTaskFromCandidate(source: Task, candidate: DoneFollowupCandidate, now: number): Task {
  return {
    id: randomUUID(),
    title: candidate.title,
    prompt: generatedTaskPrompt(source, candidate),
    column: "backlog",
    agent: source.agent,
    workdir: source.workdir,
    isolation: source.isolation,
    taskType: "task",
    branch: null,
    branchSource: "created",
    worktreePath: null,
    baseRef: null,
    prUrl: null,
    issueUrl: null,
    mode: source.mode,
    model: source.model,
    effort: source.effort,
    fast: source.fast,
    maxMode: source.maxMode,
    doneFollowupsEnabled: false,
    references: [],
    backlog: [],
    draft: null,
    plans: [],
    runId: null,
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
  };
}

function requestEligibility(
  request: DoneFollowupRequest,
  runtime: DoneFollowupRuntime,
): { task: Task; run: Run; collection: DoneFollowupCollection } | { reason: DoneFollowupEligibilityReason } {
  const task = tasks.get(request.sourceTaskId);
  if (!task) return { reason: "source-task-missing" };
  if (task.archivedAt != null) return { reason: "source-archived" };
  if (task.column !== "done") return { reason: "source-not-done" };
  if (task.runId !== request.sourceRunId) return { reason: "latest-run-changed" };
  const run = runs.get(request.sourceRunId);
  if (!run) return { reason: "no-latest-run" };
  const normal = isDoneFollowupsEligible(task, inferredRunKind(task, run, runtime));
  if (!normal.ok) return normal;
  if (run.status !== "succeeded") return { reason: "run-not-succeeded" };
  if (run.doneFollowupsEnabled !== true) return { reason: "run-snapshot-disabled" };
  if (runtime.hasPendingWork?.(task, run) === true) return { reason: "pending-work" };
  const collection = getDoneFollowupCollection(request.sourceRunId);
  if (!collection) return { reason: "collection-missing" };
  if (collection.status !== "collected") return { reason: "collection-failed" };
  return { task, run, collection };
}

function generatedForRequest(request: DoneFollowupRequest): DoneFollowupGeneratedLink[] {
  return listGeneratedDoneFollowupsForSource(request.sourceTaskId)
    .filter((link) => link.requestId === request.id);
}

function processRequestInner(input: ProcessDoneFollowupRequestInput): ProcessDoneFollowupRequestResult {
  const request = getDoneFollowupRequest(input.requestId);
  if (!request) return { status: "not-found" };
  if (request.status === "succeeded") {
    return { status: "already-succeeded", request, generated: generatedForRequest(request) };
  }
  if (request.status === "failed" && input.retry !== true) {
    return { status: "needs-retry", request };
  }
  if (request.status === "suppressed") {
    return { status: "suppressed", request, reason: storedSuppressionReason(request) };
  }
  if (request.status === "processing" && input.recovery !== true) {
    return { status: "deferred", request, reason: "pending-work" };
  }

  const eligibility = requestEligibility(request, input);
  if ("reason" in eligibility) {
    if (eligibility.reason === "pending-work") {
      // Done is a deliberate, one-shot human action.  If the source becomes
      // ineligible between queuing and materialisation, leave a durable reason
      // rather than a request that only boot recovery could ever retry.
      const suppressed = suppressRequest(request, eligibility.reason, input.now ?? Date.now());
      return { status: "suppressed", request: suppressed, reason: eligibility.reason };
    }
    const suppressed = suppressRequest(request, eligibility.reason, input.now ?? Date.now());
    return { status: "suppressed", request: suppressed, reason: eligibility.reason };
  }

  const now = input.now ?? Date.now();
  db.run(
    "UPDATE done_followup_requests "
      + "SET status = 'processing', error = NULL, attempt_count = attempt_count + 1, updated_at = ? "
      + "WHERE id = ?",
    [now, request.id],
  );
  for (const candidate of eligibility.collection.candidates) {
    const prior = db.query<GeneratedRow, [string]>(
      "SELECT * FROM done_followup_generated_tasks WHERE candidate_id = ?",
    ).get(candidate.id);
    if (prior) continue;
    const generated = tasks.insert(generatedTaskFromCandidate(eligibility.task, candidate, now));
    db.run(
      "INSERT INTO done_followup_generated_tasks "
        + "(candidate_id, request_id, source_task_id, source_run_id, generated_task_id, created_at) "
        + "VALUES (?, ?, ?, ?, ?, ?)",
      [candidate.id, request.id, request.sourceTaskId, request.sourceRunId, generated.id, now],
    );
  }
  db.run(
    "UPDATE done_followup_requests SET status = 'succeeded', error = NULL, updated_at = ? WHERE id = ?",
    [now, request.id],
  );
  const succeeded = getDoneFollowupRequest(request.id)!;
  return { status: "succeeded", request: succeeded, generated: generatedForRequest(succeeded) };
}

/**
 * All generated rows and their candidate links are one SQLite transaction.
 * A write failure rolls all of them back, then records a durable failed
 * request in a separate transaction so the saved candidates remain available
 * for an explicit retry without rerunning a CLI.
 */
export function processDoneFollowupRequest(
  input: ProcessDoneFollowupRequestInput,
): ProcessDoneFollowupRequestResult {
  try {
    return transact(() => processRequestInner(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const request = requestFailure(input.requestId, message, input.now ?? Date.now());
    return request
      ? { status: "failed", request, error: message }
      : { status: "not-found" };
  }
}

export function retryDoneFollowupRequest(
  requestId: string,
  runtime: DoneFollowupRuntime = {},
): ProcessDoneFollowupRequestResult {
  return processDoneFollowupRequest({ requestId, ...runtime, retry: true });
}

/**
 * Restart recovery has two deliberately separate phases:
 *
 * 1. A process can die after a successful run's assistant events are saved
 *    but before the normal completion hook writes its collection.  Rebuild
 *    every missing snapshot-enabled collection from those durable events.
 *    Historical rows default their snapshot to false, so this is recovery of
 *    an interrupted current flow rather than a scan that invents follow-ups
 *    for old Done tasks.
 * 2. Replay only outstanding durable creation requests.  Failed work still
 *    waits for a human retry, and current source state is rechecked before
 *    every generated insert.
 *
 * The return shape intentionally remains the request-processing results for
 * compatibility with callers that only need to schedule outstanding work;
 * callers can inspect a recovered collection through
 * `getDoneFollowupCollection(runId)`.
 */
export function recoverDoneFollowupRequests(
  runtime: DoneFollowupRuntime = {},
): ProcessDoneFollowupRequestResult[] {
  const missingCollections = db.query<{ id: string }, []>(
    "SELECT r.id FROM runs r "
      + "LEFT JOIN done_followup_collections c ON c.run_id = r.id "
      + "WHERE r.status = 'succeeded' "
      + "AND r.done_followups_enabled = 1 "
      + "AND c.run_id IS NULL "
      + "ORDER BY r.ended_at ASC, r.started_at ASC, r.id ASC",
  ).all();
  for (const row of missingCollections) {
    // A task may have changed agent after launch. `collect...` resolves the
    // frozen `run.agent`, not the mutable task agent, before it persists.
    collectDoneFollowupsForRun({ runId: row.id, ...runtime });
  }

  const rows = db.query<{ id: string }, []>(
    "SELECT id FROM done_followup_requests "
      + "WHERE status IN ('pending', 'processing') ORDER BY created_at ASC, id ASC",
  ).all();
  return rows.map((row) => processDoneFollowupRequest({
    requestId: row.id,
    ...runtime,
    recovery: true,
  }));
}
