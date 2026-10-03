import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import sql from "./migrations/062_development_workflows.sql" with { type: "text" };
import { createWorkflowApi } from "./workflow-api.ts";
import { WorkflowEngine } from "./workflow-engine.ts";
import type { DevelopmentIssue, WorkflowAgentResult, WorkflowGit, WorkflowLaunchManifest, WorkflowPullRequest, WorkflowRunnerObservation, WorkflowStage } from "../shared/development-workflow.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const requirements = { purpose: "Add a counter", scope: "Counter endpoint", outOfScope: "Authentication changes",
  acceptanceCriteria: ["GET /counter returns a number"], approach: "Reuse the existing server", assumptions: ["One process"] };
const projectPath = "/fixture/project";

function fixture() {
  const db = new Database(":memory:"); databases.push(db); db.exec(sql);
  let now = Date.UTC(2026, 9, 2, 12), merges = 0;
  const starts: WorkflowLaunchManifest[] = [], observed: string[] = [];
  const states = new Map<string, WorkflowRunnerObservation>();
  let pr: WorkflowPullRequest = { number: 7, url: "https://github.com/fixture/project/pull/7", headSha: "b".repeat(40), baseBranch: "main", state: "open", mergeable: true, mergeableState: "clean", checks: "passed", reviewDecision: "none" };
  const workspace = { workdir: "/fixture/worktree", branch: "kaname/fixture", baseSha: "a".repeat(40), headSha: "a".repeat(40), repository: "fixture/project" };
  const git: WorkflowGit = {
    async prepare() { return { ...workspace }; },
    async checkpoint() { return { ...workspace, headSha: "b".repeat(40) }; },
    async publish() { return { ...pr }; }, async inspect() { return { ...pr }; },
    async merge() { merges++; pr = { ...pr, state: "merged" }; return { ...pr }; },
    async verify() {}, async diff() { return "diff --git a/counter.ts b/counter.ts\n+return 1;"; },
  };
  const engine = new WorkflowEngine(db, {
    artifactRoot: "/fixture/artifacts", clock: () => now, git, projectExists: p => p === projectPath,
    runner: {
      async start(manifest) { starts.push(manifest); states.set(manifest.attemptId, { status: "running", startedAt: now, logs: `${manifest.stage} fixture log` }); },
      async inspect(id) { observed.push(id); return states.get(id) ?? { status: "unknown" }; },
      async stop(id) { states.set(id, { status: "stopped", startedAt: states.get(id)?.startedAt ?? now, endedAt: now, error: "stopped" }); },
    },
  });
  engine.setProjectSettings(projectPath, { model: "fixture-model", effort: "low", validationCommands: ["fixture test"], githubEnabled: true });
  const handler = createWorkflowApi(engine);
  async function call(route: string, method = "GET", input?: unknown) {
    const response = await handler(new Request(`http://127.0.0.1${route}`, { method,
      ...(input === undefined ? {} : { body: JSON.stringify(input), headers: { "content-type": "application/json" } }) }));
    return { status: response.status, value: await response.json() as any, headers: response.headers };
  }
  async function create(extra: Record<string, unknown> = {}): Promise<DevelopmentIssue> {
    const result = await call("/workflow/issues", "POST", { projectPath, goal: "Add a counter", ...extra });
    expect(result.status).toBe(201); return result.value;
  }
  async function until(id: string, predicate: (issue: DevelopmentIssue) => boolean) {
    for (let i = 0; i < 20 && !predicate(engine.getDetail(id).issue); i++) await engine.tick();
    const issue = engine.getDetail(id).issue; expect(predicate(issue)).toBe(true); return issue;
  }
  const stage = (id: string, wanted: WorkflowStage) => until(id, issue => issue.stage === wanted && issue.status === "running");
  function finish(result: WorkflowAgentResult) {
    const attempt = starts.at(-1)!; now += 1000;
    if (attempt.stage === "validation" && result.validationPassed) result = { ...result,
      validationReports: attempt.validationCommands?.map(command => ({ command, exitCode: 0, startedAt: now - 1000, endedAt: now })) };
    states.set(attempt.attemptId, { status: "stopped", startedAt: now - 1000, endedAt: now, result, logs: `${attempt.stage} complete` });
  }
  async function approval(id: string) {
    await stage(id, "research"); finish({ status: "completed", summary: "Requirements ready", requirements });
    await stage(id, "implementation"); finish({ status: "completed", summary: "Implemented" });
    await stage(id, "validation"); finish({ status: "completed", summary: "Tests passed", validationPassed: true });
    await stage(id, "review"); finish({ status: "completed", summary: "Review passed", reviewPassed: true });
    return until(id, issue => issue.stage === "approval" && issue.status === "waiting");
  }
  return { engine, handler, call, create, starts, observed, stage, finish, approval, until,
    merges: () => merges, setPr: (patch: Partial<WorkflowPullRequest>) => { pr = { ...pr, ...patch }; } };
}

test("HTTP creation is inert until revision-checked Ready; forged lifecycle fields cannot set Done", async () => {
  const f = fixture();
  const issue = await f.create({ status: "done", stage: "merge", approvedSha: "b".repeat(40) });
  expect(issue.status).toBe("backlog"); expect(issue.stage).toBe("research"); expect(issue.approvedSha).toBeNull();
  await f.engine.tick(); expect(f.starts).toHaveLength(0); expect(f.engine.store.jobs()).toHaveLength(0);
  const list = await f.call("/workflow/issues"); expect(list.value).toHaveLength(1); expect(list.headers.get("cache-control")).toBe("no-store");
  expect((await f.call(`/workflow/issues/${issue.id}/ready`, "POST", { revision: 99 })).status).toBe(409);
  const ready = await f.call(`/workflow/issues/${issue.id}/ready`, "POST", { revision: issue.revision, idempotencyKey: "ready-once" });
  expect(ready.status).toBe(200); expect(f.starts).toHaveLength(0);
  await f.stage(issue.id, "research"); expect(f.starts).toHaveLength(1);
  for (const method of ["PATCH", "PUT", "POST"]) expect((await f.call(`/workflow/issues/${issue.id}`, method, { status: "done", stage: "merge" })).status).toBe(404);
  expect((await f.call(`/workflow/issues/${issue.id}/done`, "POST", { revision: ready.value.revision })).status).toBe(404);
  expect(f.engine.getDetail(issue.id).issue.status).toBe("running"); expect(f.merges()).toBe(0);
});

test("HTTP project/global configuration validates inputs before persistence", async () => {
  const f = fixture();
  for (const input of [{ projectPath: "relative", goal: "x" }, { projectPath: "/unregistered", goal: "x" }, { projectPath, goal: " " }]) {
    expect((await f.call("/workflow/issues", "POST", input)).status).toBe(input.projectPath === "/unregistered" ? 404 : 400);
  }
  const before = (await f.call(`/workflow/projects?path=${encodeURIComponent(projectPath)}`)).value;
  for (const invalid of [{ remote: "-delete" }, { baseBranch: "main..other" }, { validationCommands: "fixture test" }, { agent: "not-a-runner" }, { githubEnabled: "yes" }, { surprise: true }]) {
    expect((await f.call("/workflow/projects", "PUT", { projectPath, ...invalid })).status).toBe(400);
  }
  expect((await f.call(`/workflow/projects?path=${encodeURIComponent(projectPath)}`)).value).toEqual(before);
  for (const invalid of [{ timezone: "Not/AZone" }, { parentBudgetMs: -1 }, { maxAgents: 0 }, { secretOption: true }]) expect((await f.call("/workflow/settings", "PUT", invalid)).status).toBe(400);
  const saved = await f.call("/workflow/settings", "PUT", { timezone: "Asia/Tokyo", dailyBudgetMs: 60 * 60_000 });
  expect(saved.status).toBe(200); expect(saved.value.timezone).toBe("Asia/Tokyo");
  const budget = await f.call("/workflow/budget"); expect(budget.value.timezone).toBe("Asia/Tokyo"); expect(budget.value.usedMs).toBe(0);
  expect((await f.call("/workflow/issues")).value).toEqual([]); expect(f.starts).toHaveLength(0);
});

test("question answers are revision-bound and idempotent; resolved notifications remain history only", async () => {
  const f = fixture(), issue = await f.create();
  await f.call(`/workflow/issues/${issue.id}/ready`, "POST", { revision: issue.revision }); await f.stage(issue.id, "research");
  f.finish({ status: "needs_input", summary: "Choose compatibility", requirements, questions: [{ question: "Keep the old API?", recommended: "Keep", alternatives: ["Remove"], impact: "Changes client compatibility" }] });
  await f.engine.tick();
  const detail = (await f.call(`/workflow/issues/${issue.id}`)).value, request = detail.requests[0];
  expect((await f.call("/workflow/inbox")).value.map((r: any) => r.id)).toEqual([request.id]);
  const notifications = (await f.call("/workflow/notifications")).value;
  expect(notifications).toHaveLength(1); expect(notifications[0].requestId).toBe(request.id);
  const endpoint = `/workflow/issues/${issue.id}/requests/${request.id}/answer`;
  expect((await f.call(endpoint, "POST", { revision: 1, answer: "Remove" })).status).toBe(409);
  const input = { revision: detail.issue.revision, answer: "Keep", idempotencyKey: "answer-once" };
  const first = await f.call(endpoint, "POST", input); expect(first.status).toBe(200);
  const duplicate = await f.call(endpoint, "POST", input); expect(duplicate.value).toEqual(first.value);
  expect((await f.call(endpoint, "POST", { ...input, revision: first.value.revision, idempotencyKey: "answer-twice" })).status).toBe(409);
  expect((await f.call("/workflow/inbox")).value).toEqual([]);
  const history = (await f.call("/workflow/notifications")).value;
  expect(history).toHaveLength(1); expect(history[0].status).toBe("suppressed");
  await f.engine.tick(); expect(f.starts).toHaveLength(2); expect(f.starts[1]!.prompt).toContain("Keep");
});

test("HTTP approval pins SHA and revision; GET links and SSE cannot approve; changed head cannot merge", async () => {
  const f = fixture(), issue = await f.create();
  await f.call(`/workflow/issues/${issue.id}/ready`, "POST", { revision: issue.revision });
  const review = await f.approval(issue.id);
  expect((await f.call(`/workflow/issues/${issue.id}/approve?headSha=${review.validatedSha}&revision=${review.revision}`)).status).toBe(404);
  expect((await f.call(`/workflow/issues/${issue.id}?approve=true`)).value.issue.status).toBe("waiting");
  const stream = await f.handler(new Request("http://127.0.0.1/workflow/events"));
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  const reader = stream.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: update"); await reader.cancel();
  expect(f.engine.getDetail(issue.id).issue.approvedSha).toBeNull(); expect(f.merges()).toBe(0);
  const endpoint = `/workflow/issues/${issue.id}/approve`;
  expect((await f.call(endpoint, "POST", { revision: review.revision, headSha: "a".repeat(40) })).status).toBe(409);
  expect((await f.call(endpoint, "POST", { revision: 1, headSha: review.validatedSha })).status).toBe(409);
  expect((await f.call(endpoint, "POST", { revision: review.revision, headSha: review.validatedSha })).status).toBe(200);
  f.setPr({ headSha: "c".repeat(40) }); await f.engine.tick();
  expect(f.merges()).toBe(0); expect(f.engine.getDetail(issue.id).issue.approvedSha).toBeNull();
  expect(f.engine.getDetail(issue.id).issue.status).toBe("stopped");
});

test("successful approved merge is reflected through HTTP while repeated approvals cannot merge again", async () => {
  const f = fixture(), issue = await f.create();
  await f.call(`/workflow/issues/${issue.id}/ready`, "POST", { revision: issue.revision }); const review = await f.approval(issue.id);
  const input = { revision: review.revision, headSha: review.validatedSha, idempotencyKey: "approve-once" };
  expect((await f.call(`/workflow/issues/${issue.id}/approve`, "POST", input)).status).toBe(200); await f.engine.tick();
  const detail = (await f.call(`/workflow/issues/${issue.id}`)).value;
  expect(detail.issue.status).toBe("done"); expect(detail.issue.pullRequest.state).toBe("merged"); expect(f.merges()).toBe(1);
  expect((await f.call(`/workflow/issues/${issue.id}/approve`, "POST", input)).status).toBe(200); await f.engine.tick(); expect(f.merges()).toBe(1);
  expect((await f.call(`/workflow/issues/${issue.id}/approve`, "POST", { revision: detail.issue.revision, headSha: review.validatedSha })).status).toBe(409);
});

test("logs require attempt ownership and API returns display-ready log and diff strings", async () => {
  const f = fixture(), a = await f.create(), b = await f.create({ title: "Second" });
  await f.call(`/workflow/issues/${a.id}/ready`, "POST", { revision: a.revision }); await f.stage(a.id, "research");
  const attemptId = f.starts[0]!.attemptId, inspections = f.observed.length;
  expect((await f.call(`/workflow/issues/${b.id}/attempts/${attemptId}/logs`)).status).toBe(404);
  expect((await f.call(`/workflow/issues/${a.id}/attempts/unknown/logs`)).status).toBe(404);
  expect(f.observed).toHaveLength(inspections);
  expect((await f.call(`/workflow/issues/${a.id}/attempts/${attemptId}/logs`)).value).toEqual({ logs: "research fixture log" });
  expect((await f.call(`/workflow/issues/${a.id}/diff`)).value.diff).toContain("+return 1");
  expect((await f.call(`/workflow/issues/${b.id}/diff`)).value).toEqual({ diff: "" });
});

test("invalid JSON, non-object bodies and oversized ASCII or UTF-8 payloads fail before mutation", async () => {
  const f = fixture();
  for (const body of ["{", "null", "[]", "1", '"text"']) {
    const r = await f.handler(new Request("http://127.0.0.1/workflow/issues", { method: "POST", body })); expect(r.status).toBe(400);
  }
  for (const padding of ["x".repeat(129 * 1024), "界".repeat(50 * 1024)]) {
    const r = await f.handler(new Request("http://127.0.0.1/workflow/issues", { method: "POST", body: JSON.stringify({ projectPath, goal: "small goal", padding }) }));
    expect(r.status).toBe(413);
  }
  const declared = await f.handler(new Request("http://127.0.0.1/workflow/issues", { method: "POST", headers: { "content-length": "200000" }, body: "{}" }));
  expect(declared.status).toBe(413); expect(f.engine.listIssues()).toHaveLength(0); expect(f.starts).toHaveLength(0);
});
