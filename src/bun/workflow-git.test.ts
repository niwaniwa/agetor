import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkflowGit, runWorkflowCommand } from "./workflow-git.ts";
import { mergeGitHubPull } from "./github.ts";
import { mockGitHubFetch } from "./github-test-util.ts";
import type { WorkflowCommand, WorkflowGitRequest, WorkflowGitRequestResult } from "./workflow-git.ts";
import type { WorkflowGitContext, WorkflowWorkspace } from "../shared/development-workflow.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "kaname-workflow-git-")); roots.push(root);
  const source = path.join(root, "source"), remote = path.join(root, "remote.git");
  mkdirSync(source); mkdirSync(remote);
  async function git(args: string[], cwd = source) {
    const r = await runWorkflowCommand(["git", ...args], cwd);
    if (r.exitCode) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  }
  await git(["init", "--bare", "-b", "main"], remote);
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Workflow fixture"]);
  writeFileSync(path.join(source, "file.txt"), "original\n");
  writeFileSync(path.join(source, ".gitignore"), "ignored-secret\n");
  await git(["add", "."]); await git(["commit", "-m", "base"]);
  await git(["remote", "add", "origin", remote]); await git(["push", "origin", "main"]);
  const baseSha = await git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(source, "user-only.txt"), "do not stage from source\n");
  const calls: Array<{ route: string; method: string; body: any }> = [];
  const state = {
    pulls: [] as any[], headSha: baseSha, checks: [] as any[], reviews: [] as any[],
    status: "success", statusCount: 0, loseCreateResponse: false, failCreateBeforeWrite: false,
    loseMergeResponse: false, rejectMerge: false, changeHeadOnMerge: false, malformedChecks: false,
    mergeState: "clean", mergeable: true as boolean | null,
  };
  const request: WorkflowGitRequest = async (_repository, route, method = "GET", body): Promise<WorkflowGitRequestResult> => {
    calls.push({ route, method, body });
    const url = new URL(`https://fixture.invalid${route}`);
    const page = Number(url.searchParams.get("page") ?? "1");
    if (url.pathname.endsWith("/check-runs")) return { status: 200, data: { total_count: state.checks.length,
      check_runs: state.malformedChecks ? null : state.checks.slice((page - 1) * 100, page * 100) } };
    if (url.pathname.endsWith("/status")) return { status: 200, data: { sha: state.headSha, state: state.status, total_count: state.statusCount, statuses: [] } };
    if (url.pathname.endsWith("/reviews")) return { status: 200, data: state.reviews.slice((page - 1) * 100, page * 100) };
    if (url.pathname === "/pulls" && method === "GET") return { status: 200, data: state.pulls };
    if (url.pathname === "/pulls" && method === "POST") {
      if (state.failCreateBeforeWrite) throw new Error("network disconnected");
      const b = body as any;
      const pr = { number: 7, html_url: "https://github.com/owner/repo/pull/7", body: b.body,
        head: { ref: b.head, sha: state.headSha, repo: { full_name: "owner/repo" } },
        base: { ref: b.base, repo: { full_name: "owner/repo" } }, state: "open", merged: false,
        mergeable: state.mergeable, mergeable_state: state.mergeState, draft: false };
      state.pulls.push(pr);
      if (state.loseCreateResponse) throw new Error("response was lost after GitHub created PR");
      return { status: 201, data: pr };
    }
    const pr = state.pulls[0];
    if (url.pathname === "/pulls/7/merge" && method === "PUT") {
      if (state.changeHeadOnMerge) pr.head.sha = "f".repeat(40);
      if (pr.head.sha !== (body as any).sha) return { status: 409, data: { message: "Head changed" } };
      if (state.rejectMerge) return { status: 200, data: { merged: false } };
      pr.merged = true; pr.state = "closed";
      if (state.loseMergeResponse) throw new Error("response lost after merge");
      return { status: 200, data: { merged: true, sha: "b".repeat(40) } };
    }
    if (url.pathname === "/pulls/7" && pr) {
      if (method === "PATCH") pr.body = (body as any).body;
      pr.mergeable = state.mergeable; pr.mergeable_state = state.mergeState;
      return { status: 200, data: pr };
    }
    throw new Error(`Unexpected mock request ${method} ${route}`);
  };
  const command: WorkflowCommand = async (argv, cwd, timeoutMs) => {
    const r = await runWorkflowCommand(argv, cwd, timeoutMs);
    if (r.exitCode === 0 && argv[1] === "push") {
      state.headSha = argv[argv.length - 1]!.split(":")[0]!;
      for (const pr of state.pulls) pr.head.sha = state.headSha;
    }
    return r;
  };
  const options = { dataRoot: path.join(root, "data"), command, request,
    resolveRepository: () => ({ owner: "owner", name: "repo", remoteHost: "github.com" }) };
  const adapter = createWorkflowGit(options);
  const context: WorkflowGitContext = { issueId: "issue-123", operationId: "prepare-1", projectPath: source, remote: "origin", baseBranch: "main" };
  async function implement(): Promise<WorkflowGitContext & { workspace: WorkflowWorkspace }> {
    const prepared = await adapter.prepare(context);
    writeFileSync(path.join(prepared.workdir, "file.txt"), "implemented\n");
    writeFileSync(path.join(prepared.workdir, "ignored-secret"), "fixture secret");
    const workspace = await adapter.checkpoint({ ...context, workspace: prepared, operationId: "checkpoint-1", summary: "Implement requested change" });
    return { ...context, workspace, operationId: "publish-1" };
  }
  return { root, source, remote, git, baseSha, calls, state, options, adapter, context, implement };
}

test("prepare pins the explicit remote base, reuses one worktree, and checkpoint stages only owned changes", async () => {
  const f = await fixture();
  const c = await f.implement();
  expect(c.workspace.baseSha).toBe(f.baseSha);
  expect(c.workspace.branch).toBe("kaname/issue-123");
  expect(c.workspace.repository).toBe("owner/repo");
  expect(await f.git(["rev-parse", "HEAD"])).toBe(f.baseSha);
  expect(await f.git(["status", "--porcelain"])).toBe("?? user-only.txt");
  expect(await f.git(["ls-tree", "--name-only", "HEAD"], c.workspace.workdir)).not.toContain("ignored-secret");
  expect(await f.adapter.prepare(f.context)).toEqual(c.workspace);
  expect(await f.adapter.checkpoint({ ...c, operationId: "checkpoint-1", summary: "duplicate" })).toEqual(c.workspace);
  expect(await f.git(["rev-list", "--count", `${f.baseSha}..HEAD`], c.workspace.workdir)).toBe("1");
  await f.adapter.verify({ ...c, expectedSha: c.workspace.headSha });
  expect(await f.adapter.diff(c)).toContain("+implemented");
  expect(f.calls).toHaveLength(0);
});

test("checkpoint crash recovery recognizes its operation commit instead of committing twice", async () => {
  const f = await fixture();
  let interrupted = false;
  const adapter = createWorkflowGit({ ...f.options, command: async (argv, cwd, timeout) => {
    const r = await f.options.command(argv, cwd, timeout);
    if (!interrupted && argv.includes("commit")) { interrupted = true; throw new Error("service stopped after commit"); }
    return r;
  } });
  const workspace = await adapter.prepare(f.context);
  writeFileSync(path.join(workspace.workdir, "file.txt"), "updated\n");
  const c = { ...f.context, workspace, operationId: "checkpoint-1", summary: "change" };
  await expect(adapter.checkpoint(c)).rejects.toThrow("service stopped");
  const recovered = await createWorkflowGit(f.options).checkpoint(c);
  expect(recovered.headSha).not.toBe(f.baseSha);
  expect(await f.git(["rev-list", "--count", `${f.baseSha}..HEAD`], workspace.workdir)).toBe("1");
});

test("no-change checkpoints remain human-blocked on retry and never publish", async () => {
  const f = await fixture();
  const workspace = await f.adapter.prepare(f.context);
  const input = { ...f.context, workspace, summary: "nothing to change", operationId: "checkpoint-1" };
  await expect(f.adapter.checkpoint(input)).rejects.toThrow("No changes");
  await expect(f.adapter.checkpoint(input)).rejects.toThrow("No changes");
  expect(f.calls).toHaveLength(0);
});

test("verify rejects edits after validation and publish rejects a replaced remote", async () => {
  const f = await fixture(); const c = await f.implement();
  writeFileSync(path.join(c.workspace.workdir, "file.txt"), "late mutation\n");
  await expect(f.adapter.verify({ ...c, expectedSha: c.workspace.headSha })).rejects.toThrow("uncommitted");
  await expect(f.adapter.publish({ ...c, title: "change", body: "description" })).rejects.toThrow("uncommitted");
  await f.git(["remote", "set-url", "origin", path.join(f.root, "other.git")]);
  await expect(f.adapter.publish({ ...c, title: "change", body: "description" })).rejects.toThrow("frozen workflow destination");
  expect(f.calls).toHaveLength(0);
});

test("lost PR response is reconciled by owned branch/base marker across restart", async () => {
  const f = await fixture(); const c = await f.implement(); f.state.loseCreateResponse = true;
  const pr = await f.adapter.publish({ ...c, title: "change", body: "validated" });
  expect(pr.headSha).toBe(c.workspace.headSha);
  expect(pr.checks).toBe("passed"); // no configured CI is not perpetual pending
  expect(pr.checksReported).toBe(false);
  const again = await createWorkflowGit(f.options).publish({ ...c, title: "change", body: "validated" });
  expect(again.number).toBe(pr.number);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(await f.git(["rev-parse", "refs/heads/kaname/issue-123"], f.remote)).toBe(c.workspace.headSha);
});

test("unconfirmed PR creation cannot blindly issue a second POST", async () => {
  const f = await fixture(); const c = await f.implement(); f.state.failCreateBeforeWrite = true;
  const input = { ...c, title: "change", body: "validated" };
  await expect(f.adapter.publish(input)).rejects.toThrow("network disconnected");
  await expect(createWorkflowGit(f.options).publish(input)).rejects.toThrow("uncertain outcome");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

test("check-runs fetch every latest page at the exact SHA and latest decisive review blocks", async () => {
  const f = await fixture(); const c = await f.implement();
  f.state.checks = Array.from({ length: 101 }, (_, id) => ({ id, name: `test-${id}`, head_sha: c.workspace.headSha, status: "completed", conclusion: id === 100 ? "failure" : "success" }));
  f.state.reviews = [
    { id: 1, user: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "fix this" },
    { id: 2, user: { login: "reviewer" }, state: "COMMENTED" },
  ];
  const pr = await f.adapter.publish({ ...c, title: "change", body: "validated" });
  expect(pr.checks).toBe("failed"); expect(pr.reviewDecision).toBe("changes_requested");
  expect(pr.checksReported).toBe(true); expect(pr.changesRequestedReviewIds).toEqual([1]);
  expect(f.calls.some((call) => call.route.includes(`/commits/${c.workspace.headSha}/check-runs?filter=latest&per_page=100&page=2`))).toBe(true);
  await expect(f.adapter.merge({ ...c, pullRequest: pr, approvedSha: c.workspace.headSha, validatedSha: c.workspace.headSha })).rejects.toThrow("not ready");
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  f.state.checks = []; f.state.reviews.push({ id: 3, user: { login: "reviewer" }, state: "APPROVED" });
  const approved = await f.adapter.inspect({ ...c, pullRequest: pr });
  expect(approved.reviewDecision).toBe("approved"); expect(approved.changesRequestedReviewIds).toEqual([]);
  f.state.reviews = [
    { id: 9, user: { login: "reviewer" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-03T12:00:00Z" },
    { id: 10, user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-10-03T11:00:00Z" },
  ];
  const requestedAgain = await f.adapter.inspect({ ...c, pullRequest: pr });
  expect(requestedAgain.reviewDecision).toBe("changes_requested"); expect(requestedAgain.changesRequestedReviewIds).toEqual([9]);
});

test("legacy status-only CI is reported, while repeated reads retain the same active review IDs", async () => {
  const f = await fixture(); const c = await f.implement();
  f.state.statusCount = 1;
  f.state.reviews = [
    { id: 3, user: { login: "first" }, state: "CHANGES_REQUESTED" },
    { id: 2, user: { login: "second" }, state: "CHANGES_REQUESTED" },
    { id: 4, user: { login: "first" }, state: "COMMENTED" },
  ];
  const pr = await f.adapter.publish({ ...c, title: "change", body: "validated" });
  expect(pr.checksReported).toBe(true); expect(pr.checks).toBe("passed");
  expect(pr.changesRequestedReviewIds).toEqual([2, 3]);
  expect((await f.adapter.inspect({ ...c, pullRequest: pr })).changesRequestedReviewIds).toEqual([2, 3]);
  f.state.reviews.push({ id: 5, user: { login: "second" }, state: "DISMISSED" });
  expect((await f.adapter.inspect({ ...c, pullRequest: pr })).changesRequestedReviewIds).toEqual([3]);
});

test("unknown or malformed CI data cannot become success", async () => {
  const f = await fixture(); const c = await f.implement(); f.state.malformedChecks = true;
  await expect(f.adapter.publish({ ...c, title: "change", body: "validated" })).rejects.toThrow("incomplete list");
  f.state.malformedChecks = false;
  f.state.checks = [{ name: "unknown", head_sha: c.workspace.headSha, status: "completed", conclusion: "new-unrecognized-value" }];
  await expect(f.adapter.publish({ ...c, title: "change", body: "validated" })).rejects.toThrow("could not be verified");
});

test("pending CI and policy blockers preserve raw mergeability instead of reporting conflicts", async () => {
  const f = await fixture(); const c = await f.implement();
  f.state.mergeState = "unstable";
  f.state.checks = [{ name: "unit", head_sha: c.workspace.headSha, status: "in_progress", conclusion: null }];
  const pr = await f.adapter.publish({ ...c, title: "change", body: "validated" });
  expect(pr.mergeable).toBe(true); expect(pr.checks).toBe("pending"); expect(pr.mergeableState).toBe("unstable");
  f.state.mergeState = "blocked"; f.state.checks = [];
  const blocked = await f.adapter.inspect({ ...c, pullRequest: pr });
  expect(blocked.mergeable).toBe(true); expect(blocked.reviewDecision).toBe("required");
  await expect(f.adapter.merge({ ...c, pullRequest: blocked, approvedSha: c.workspace.headSha, validatedSha: c.workspace.headSha })).rejects.toThrow("not ready");
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
});

test("merge includes SHA and squash, confirms actual merge, and recovers a lost response", async () => {
  const f = await fixture(); const c = await f.implement();
  const pr = await f.adapter.publish({ ...c, title: "change", body: "validated" });
  f.state.loseMergeResponse = true;
  const input = { ...c, pullRequest: pr, approvedSha: c.workspace.headSha, validatedSha: c.workspace.headSha };
  const merged = await f.adapter.merge(input);
  expect(merged.state).toBe("merged");
  expect(f.calls.find((call) => call.method === "PUT")?.body).toEqual({ merge_method: "squash", sha: c.workspace.headSha });
  expect((await createWorkflowGit(f.options).merge(input)).state).toBe("merged");
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

test("SHA races, mergeable unknown, and 2xx unmerged responses never complete", async () => {
  const f = await fixture(); const c = await f.implement();
  const pr = await f.adapter.publish({ ...c, title: "change", body: "validated" });
  const input = { ...c, pullRequest: pr, approvedSha: c.workspace.headSha, validatedSha: c.workspace.headSha };
  f.state.mergeable = null;
  await expect(f.adapter.merge(input)).rejects.toThrow("not ready");
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  f.state.mergeable = true; f.state.rejectMerge = true;
  await expect(f.adapter.merge(input)).rejects.toThrow("not confirmed");
  f.state.rejectMerge = false; f.state.changeHeadOnMerge = true;
  await expect(f.adapter.merge(input)).rejects.toThrow("409");
  expect(f.state.pulls[0].merged).toBe(false);
});

test("generic GitHub merge helper preserves optional SHA guard and rejects malformed guards", async () => {
  const f = await fixture();
  await f.git(["remote", "set-url", "origin", "https://github.com/owner/repo.git"]);
  const originalDataDir = process.env.AGETOR_DATA_DIR, originalToken = process.env.GITHUB_TOKEN;
  process.env.AGETOR_DATA_DIR = path.join(f.root, "auth-fixture");
  process.env.GITHUB_TOKEN = "fixture-token";
  const mock = mockGitHubFetch([{ method: "PUT", match: "/repos/owner/repo/pulls/7/merge", json: { merged: true, sha: "b".repeat(40) } }]);
  try {
    const guarded = await mergeGitHubPull({ dir: f.source, number: 7, method: "squash", expectedHeadSha: f.baseSha });
    expect(guarded.ok).toBe(true);
    expect(JSON.parse(mock.calls[0]!.body!)).toEqual({ merge_method: "squash", sha: f.baseSha });
    await mergeGitHubPull({ dir: f.source, number: 7, method: "merge" });
    expect(JSON.parse(mock.calls[1]!.body!)).toEqual({ merge_method: "merge" });
    expect((await mergeGitHubPull({ dir: f.source, number: 7, method: "squash", expectedHeadSha: "main" })).ok).toBe(false);
    expect(mock.calls).toHaveLength(2);
  } finally {
    mock.restore();
    if (originalDataDir === undefined) delete process.env.AGETOR_DATA_DIR; else process.env.AGETOR_DATA_DIR = originalDataDir;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = originalToken;
  }
});
