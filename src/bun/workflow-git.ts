import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { githubToken, parseGitRemote } from "./github.ts";
import type { WorkflowGit, WorkflowGitContext, WorkflowPullRequest, WorkflowWorkspace } from "../shared/development-workflow.ts";

/** GitHub side effects for the development workflow. The engine owns scheduling,
 * approvals and durable jobs; this adapter owns a pinned Git destination and
 * reconciles ambiguous external results before retrying a write. */
export interface WorkflowRepository { owner: string; name: string; remoteHost: string }
export interface WorkflowCommandResult { exitCode: number; stdout: string; stderr: string }
export type WorkflowCommand = (argv: string[], cwd: string, timeoutMs?: number) => Promise<WorkflowCommandResult>;
export interface WorkflowGitRequestResult { status: number; data: unknown; headers?: Headers }
export type WorkflowGitRequest = (repository: WorkflowRepository, route: string, method?: string, body?: unknown) => Promise<WorkflowGitRequestResult>;
export interface WorkflowGitInput {
  kind: "prepare" | "checkpoint" | "publish" | "inspect" | "merge";
  operationId: string;
  issueId: string;
  projectPath: string;
  baseBranch: string;
  remoteName?: string;
  workdir?: string;
  branch?: string;
  headSha?: string;
  title: string;
  body?: string;
  approvedSha?: string;
}
export interface WorkflowPull {
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  draft: boolean;
  checks: "success" | "pending" | "failure" | "unknown";
  reviewDecision: "approved" | "changes_requested" | "none";
  checksReported?: boolean;
  changesRequestedReviewIds: number[];
  feedback: string[];
}
export type WorkflowGitResult = {
  ok: true;
  workdir: string;
  branch: string;
  baseSha: string;
  headSha: string;
  repository: WorkflowRepository;
  remoteName: string;
  changed: boolean;
  pr?: WorkflowPull;
} | { ok: false; error: string; reason: string; retryable: boolean };
interface Manifest {
  version: 1;
  issueId: string;
  projectPath: string;
  workdir: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  remoteName: string;
  remoteUrl: string;
  repository: WorkflowRepository;
  checkpoints: Record<string, { headSha: string; tree: string; parent: string }>;
  prNumber?: number;
  /** A write may have reached GitHub even if its response never arrived. */
  publishAttempted?: boolean;
}
class GitFailure extends Error {
  constructor(message: string, readonly reason = "git_error", readonly retryable = false, readonly httpStatus?: number) { super(message); }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const shaValid = (value: string): boolean => /^[0-9a-f]{40}$/i.test(value);
const idValid = (value: string): boolean => /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

export const runWorkflowCommand: WorkflowCommand = async (argv, cwd, timeoutMs = 30_000) => {
  const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
};

export const requestWorkflowGitHub: WorkflowGitRequest = async (repository, route, method = "GET", body) => {
  if (!route.startsWith("/") || route.startsWith("//")) throw new GitFailure("Invalid GitHub API route");
  const token = await githubToken(repository.remoteHost);
  if (!token) throw new GitFailure("GitHub authentication is required", "authentication");
  // The only production destination is github.com. Tests inject a transport,
  // rather than redirecting credential-bearing requests to arbitrary hosts.
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${route}`, {
    method, signal: AbortSignal.timeout(30_000), redirect: "error",
    headers: { accept: "application/vnd.github+json", "user-agent": "kaname", authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
};

export function createWorkflowGit(options: {
  dataRoot: string;
  command?: WorkflowCommand;
  request?: WorkflowGitRequest;
  /** Test seam for local bare remotes; production resolves the configured URL. */
  resolveRepository?: (remoteUrl: string) => WorkflowRepository | null;
}): WorkflowGit & { operation(input: WorkflowGitInput): Promise<WorkflowGitResult> } {
  const command = options.command ?? runWorkflowCommand;
  const request = options.request ?? requestWorkflowGitHub;
  const root = path.resolve(options.dataRoot, "development-git");
  const locks = new Map<string, Promise<unknown>>();
  const manifestPath = (id: string) => path.join(root, `${id}.json`);
  const save = (m: Manifest) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = manifestPath(m.issueId);
    writeFileSync(`${file}.tmp`, JSON.stringify(m), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const git = async (args: string[], cwd: string, timeoutMs?: number) => {
    const result = await command(["git", ...args], cwd, timeoutMs);
    if (result.exitCode !== 0) throw new GitFailure(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
    return result.stdout.trim();
  };
  const resolveRepository = options.resolveRepository ?? ((url: string) => {
    const repo = parseGitRemote(url);
    if (!repo || repo.host !== "github.com" || !/^[\w.-]+$/.test(repo.owner) || !/^[\w.-]+$/.test(repo.name)) return null;
    // Never persist a URL containing embedded HTTP credentials.
    if (/^https?:/.test(url)) {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || parsed.hostname !== "github.com" || parsed.protocol !== "https:") return null;
    }
    return { owner: repo.owner, name: repo.name, remoteHost: repo.rawHost };
  });
  const api = async (m: Manifest, route: string, method?: string, body?: unknown): Promise<WorkflowGitRequestResult> => {
    let result: WorkflowGitRequestResult;
    try { result = await request(m.repository, route, method, body); }
    catch (error) {
      if (error instanceof GitFailure) throw error;
      throw new GitFailure(`GitHub request could not be confirmed: ${error instanceof Error ? error.message : String(error)}`, "github_unavailable", true);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new GitFailure(`GitHub returned ${result.status}: ${string(object(result.data).message) || "request rejected"}`,
        result.status === 401 || result.status === 403 ? "github_permission" : result.status === 409 ? "head_changed" : "github_rejected", result.status >= 500 || result.status === 429, result.status);
    }
    return result;
  };
  const list = async (m: Manifest, route: string, key?: string): Promise<unknown[]> => {
    const collected: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await api(m, `${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const rows = key ? object(result.data)[key] : result.data;
      if (!Array.isArray(rows)) throw new GitFailure("GitHub returned an incomplete list", "github_unknown", true);
      collected.push(...rows);
      const total = key ? object(result.data).total_count : undefined;
      const hasNext = /rel="next"/.test(result.headers?.get("link") ?? "");
      if (!hasNext && (typeof total === "number" ? collected.length >= total : rows.length < 100)) return collected;
      if (rows.length === 0) throw new GitFailure("GitHub pagination did not return all results", "github_unknown", true);
    }
    throw new GitFailure("GitHub results exceed the safe pagination limit", "github_unknown");
  };
  const assertTarget = async (m: Manifest, input: WorkflowGitInput, requireWorktree = true) => {
    if (realpathSync(input.projectPath) !== m.projectPath || input.baseBranch !== m.baseBranch || (input.remoteName ?? "origin") !== m.remoteName ||
      (input.workdir && path.resolve(input.workdir) !== m.workdir) || (input.branch && input.branch !== m.branch)) {
      throw new GitFailure("The workflow's frozen Git target has changed", "target_changed");
    }
    const urls = await git(["remote", "get-url", "--push", "--all", m.remoteName], m.projectPath);
    const fetchUrl = await git(["remote", "get-url", m.remoteName], m.projectPath);
    if (urls !== m.remoteUrl || fetchUrl !== m.remoteUrl) throw new GitFailure("Configured remote differs from the frozen workflow destination", "target_changed");
    if (requireWorktree) {
      if (!existsSync(m.workdir) || realpathSync(m.workdir) !== m.workdir) throw new GitFailure("The owned worktree is missing or was replaced", "worktree_changed");
      const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], m.workdir);
      if (branch !== m.branch) throw new GitFailure("The owned worktree is on a different branch", "worktree_changed");
      const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], m.workdir);
      const expected = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], m.projectPath);
      if (realpathSync(common) !== realpathSync(expected)) throw new GitFailure("The worktree belongs to a different repository", "worktree_changed");
    }
  };
  const assertClean = async (m: Manifest, expected?: string) => {
    const head = await git(["rev-parse", "HEAD"], m.workdir);
    if (expected && head !== expected) throw new GitFailure("The worktree HEAD changed after validation", "head_changed");
    if (await git(["status", "--porcelain=v1", "--untracked-files=all"], m.workdir)) throw new GitFailure("The worktree contains uncommitted changes", "uncommitted_changes");
    return head;
  };
  const pull = (m: Manifest, raw: unknown): WorkflowPull => {
    const p = object(raw), head = object(p.head), base = object(p.base);
    const headRepo = string(object(head.repo).full_name).toLowerCase();
    const baseRepo = string(object(base.repo).full_name).toLowerCase();
    const repo = `${m.repository.owner}/${m.repository.name}`.toLowerCase();
    if (!Number.isInteger(p.number) || Number(p.number) <= 0 || !shaValid(string(head.sha)) || !string(p.html_url) ||
      head.ref !== m.branch || base.ref !== m.baseBranch || headRepo !== repo || baseRepo !== repo) {
      throw new GitFailure("GitHub PR does not match this workflow's repository and branches", "pr_mismatch");
    }
    if (p.state !== "open" && p.state !== "closed") throw new GitFailure("GitHub PR state is unknown", "github_unknown", true);
    const merged = p.merged === true || (typeof p.merged_at === "string" && p.merged_at.length > 0);
    if (merged && p.state !== "closed") throw new GitFailure("GitHub PR state is inconsistent", "github_unknown", true);
    return { number: Number(p.number), url: string(p.html_url), headSha: string(head.sha), baseBranch: string(base.ref),
      state: merged ? "merged" : p.state, merged,
      mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null, mergeableState: string(p.mergeable_state) || "unknown", draft: p.draft === true,
      checks: "unknown", reviewDecision: "none", changesRequestedReviewIds: [], feedback: [] };
  };
  const marker = (m: Manifest) => `<!-- kaname-workflow:${m.issueId} -->`;
  const findPull = async (m: Manifest): Promise<WorkflowPull | null> => {
    if (m.prNumber) return pull(m, (await api(m, `/pulls/${m.prNumber}`)).data);
    const rows = await list(m, `/pulls?state=all&head=${encodeURIComponent(`${m.repository.owner}:${m.branch}`)}&base=${encodeURIComponent(m.baseBranch)}`);
    const matches = rows.filter((row) => string(object(row).body).includes(marker(m)));
    if (matches.length > 1) throw new GitFailure("Multiple PRs claim this workflow; human reconciliation is required", "duplicate_pr");
    if (matches.length === 0) {
      if (rows.length) throw new GitFailure("A PR already uses the workflow branch without its identity marker", "pr_mismatch");
      return null;
    }
    const found = pull(m, matches[0]);
    m.prNumber = found.number; save(m);
    return pull(m, (await api(m, `/pulls/${found.number}`)).data);
  };
  const inspectPull = async (m: Manifest): Promise<WorkflowPull> => {
    const p = await findPull(m);
    if (!p) throw new GitFailure("No PR exists for this workflow", "missing_pr");
    if (p.merged || p.state === "closed") return p;
    const [checks, statusResult, reviews] = await Promise.all([
      list(m, `/commits/${p.headSha}/check-runs?filter=latest`, "check_runs"),
      api(m, `/commits/${p.headSha}/status`), list(m, `/pulls/${p.number}/reviews`),
    ]);
    const status = object(statusResult.data);
    let state: WorkflowPull["checks"] = "success";
    const priority = { success: 0, pending: 1, failure: 2, unknown: 3 };
    const add = (next: WorkflowPull["checks"]) => { if (priority[next] > priority[state]) state = next; };
    for (const row of checks) {
      const check = object(row);
      if (check.head_sha !== p.headSha || typeof check.name !== "string") { add("unknown"); continue; }
      if (check.status === "queued" || check.status === "in_progress" || check.status === "waiting" || check.status === "pending" || check.status === "requested") add("pending");
      else if (check.status !== "completed") add("unknown");
      else if (["success", "neutral", "skipped"].includes(string(check.conclusion))) { /* passed */ }
      else if (["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(string(check.conclusion))) { add("failure"); p.feedback.push(`Check ${check.name}: ${check.conclusion}`); }
      else add("unknown");
    }
    if (typeof status.total_count !== "number" || !Number.isInteger(status.total_count) || status.total_count < 0 ||
      !["success", "pending", "failure", "error"].includes(string(status.state)) || (status.sha !== undefined && status.sha !== p.headSha)) add("unknown");
    else if (status.total_count > 0) {
      if (status.state === "failure" || status.state === "error") { add("failure"); p.feedback.push("Commit status reports a failure"); }
      else if (status.state === "pending") add("pending");
      else if (status.state !== "success") add("unknown");
    }
    p.checks = state;
    p.checksReported = checks.length > 0 || typeof status.total_count === "number" && status.total_count > 0;
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of reviews) {
      const review = object(row);
      if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(string(review.state))) continue;
      const user = string(object(review.user).login);
      if (!user || typeof review.id !== "number") throw new GitFailure("GitHub returned an incomplete review", "github_unknown", true);
      const previous = latest.get(user);
      // Pending reviews receive IDs before submission. Use submission time
      // when present so a later-submitted changes request cannot be hidden by
      // an approval with a higher allocation ID.
      const submitted = Date.parse(string(review.submitted_at));
      const previousSubmitted = Date.parse(string(previous?.submitted_at));
      if (!previous || (Number.isFinite(submitted) && Number.isFinite(previousSubmitted)
        ? submitted > previousSubmitted || submitted === previousSubmitted && Number(previous.id) < review.id
        : Number(previous.id) < review.id)) latest.set(user, review);
    }
    for (const review of latest.values()) {
      if (review.state === "CHANGES_REQUESTED") {
        p.reviewDecision = "changes_requested";
        p.changesRequestedReviewIds.push(Number(review.id));
        p.feedback.push(string(review.body) || "Changes requested by a reviewer");
      }
      else if (review.state === "APPROVED" && p.reviewDecision === "none") p.reviewDecision = "approved";
    }
    p.changesRequestedReviewIds.sort((a, b) => a - b);
    return p;
  };
  const result = async (m: Manifest, pr?: WorkflowPull): Promise<WorkflowGitResult> => {
    const headSha = await git(["rev-parse", "HEAD"], m.workdir);
    const diff = await git(["diff", "--name-only", m.baseSha, headSha, "--"], m.workdir);
    return { ok: true, workdir: m.workdir, branch: m.branch, baseSha: m.baseSha, headSha, repository: m.repository, remoteName: m.remoteName, changed: diff.length > 0, ...(pr ? { pr } : {}) };
  };
  const execute = async (input: WorkflowGitInput): Promise<WorkflowGitResult> => {
    if (!idValid(input.issueId) || !input.operationId || !input.baseBranch || input.baseBranch.startsWith("-") ||
      !/^[\w.-]+$/.test(input.remoteName ?? "origin")) throw new GitFailure("Invalid workflow Git identity", "invalid_input");
    if (input.headSha && !shaValid(input.headSha) || input.approvedSha && !shaValid(input.approvedSha)) throw new GitFailure("A full commit SHA is required", "invalid_input");
    let m: Manifest | null = existsSync(manifestPath(input.issueId)) ? JSON.parse(readFileSync(manifestPath(input.issueId), "utf8")) : null;
    if (input.kind === "prepare") {
      if (!m) {
        const projectPath = realpathSync(input.projectPath);
        const repoRoot = await git(["rev-parse", "--show-toplevel"], projectPath);
        if (realpathSync(repoRoot) !== projectPath) throw new GitFailure("Workflow project must be the repository root", "invalid_project");
        await git(["check-ref-format", "--branch", input.baseBranch], projectPath);
        const remoteName = input.remoteName ?? "origin";
        const remoteUrl = await git(["remote", "get-url", remoteName], projectPath);
        const repository = resolveRepository(remoteUrl);
        if (!repository) throw new GitFailure("Workflow requires an explicit GitHub remote without embedded credentials", "invalid_remote");
        if (await git(["remote", "get-url", "--push", "--all", remoteName], projectPath) !== remoteUrl) throw new GitFailure("Separate or multiple push URLs are not supported", "invalid_remote");
        const baseRef = `refs/kaname/bases/${input.issueId}`;
        await git(["fetch", "--no-tags", "--", remoteName, `refs/heads/${input.baseBranch}:${baseRef}`], projectPath, 120_000);
        const baseSha = await git(["rev-parse", `${baseRef}^{commit}`], projectPath);
        if (!shaValid(baseSha)) throw new GitFailure("Could not resolve base commit", "invalid_base");
        const branch = `kaname/${input.issueId}`;
        const existing = await command(["git", "show-ref", "--verify", `refs/heads/${branch}`], projectPath);
        if (existing.exitCode === 0) throw new GitFailure("Workflow branch already exists without ownership metadata", "branch_collision");
        mkdirSync(path.join(root, "worktrees"), { recursive: true, mode: 0o700 });
        m = { version: 1, issueId: input.issueId, projectPath, workdir: path.join(realpathSync(root), "worktrees", input.issueId), branch,
          baseBranch: input.baseBranch, baseSha, remoteName, remoteUrl, repository, checkpoints: {} };
        save(m);
      }
      await assertTarget(m, input, false);
      if (!existsSync(m.workdir)) {
        const existing = await command(["git", "show-ref", "--verify", `refs/heads/${m.branch}`], m.projectPath);
        await git(existing.exitCode === 0 ? ["worktree", "add", m.workdir, m.branch] : ["worktree", "add", "-b", m.branch, m.workdir, m.baseSha], m.projectPath);
      }
      await assertTarget(m, input);
      return result(m);
    }
    if (!m) throw new GitFailure("Workflow worktree has not been prepared", "not_prepared");
    await assertTarget(m, input);
    if (input.kind === "checkpoint") {
      const key = hash(input.operationId);
      const old = m.checkpoints[key];
      if (old?.headSha) {
        await assertClean(m, old.headSha);
        const r = await result(m);
        if (r.ok && !r.changed) throw new GitFailure("No changes relative to the base branch", "no_changes");
        return r;
      }
      // Only this workflow's dedicated worktree is staged. Never stage the
      // user's checkout, follow symlinks, or force-add ignored secrets/artifacts.
      await git(["add", "--all", "--", "."], m.workdir);
      const tree = await git(["write-tree"], m.workdir);
      const parent = await git(["rev-parse", "HEAD"], m.workdir);
      if (old && (old.tree !== tree || old.parent !== parent)) {
        const message = await git(["log", "-1", "--format=%B"], m.workdir);
        if (tree === old.tree && message.includes(`KANAME-Operation: ${key}`)) {
          old.headSha = parent; save(m); await assertClean(m, parent); return result(m);
        }
        throw new GitFailure("Checkpoint outcome differs from its saved operation", "checkpoint_changed");
      }
      const parentTree = await git(["rev-parse", "HEAD^{tree}"], m.workdir);
      if (tree !== parentTree) {
        m.checkpoints[key] = { headSha: "", parent, tree }; save(m);
        const title = input.title.replace(/[\r\n]/g, " ").trim().slice(0, 160) || "KANAME development workflow";
        await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", title, "-m", `KANAME-Operation: ${key}`], m.workdir);
      }
      const headSha = await assertClean(m);
      m.checkpoints[key] = { headSha, parent, tree }; save(m);
      const r = await result(m);
      if (r.ok && !r.changed) throw new GitFailure("No changes relative to the base branch; additional instructions or cancellation are required", "no_changes");
      return r;
    }
    if (input.kind === "publish") {
      if (!input.headSha) throw new GitFailure("Validated head SHA is required before publishing", "invalid_input");
      await assertClean(m, input.headSha);
      const existing = await findPull(m);
      if (existing && existing.state !== "open") throw new GitFailure("The workflow PR is already closed or merged", "pr_closed");
      const diff = await git(["diff", "--name-only", m.baseSha, input.headSha, "--"], m.workdir);
      if (!diff) throw new GitFailure("No changes to publish", "no_changes");
      // Explicit remote and refspec, no force. A lost push response is safely
      // retried only for the same immutable commit and owned branch.
      await git(["push", "--", m.remoteName, `${input.headSha}:refs/heads/${m.branch}`], m.workdir, 120_000);
      await assertClean(m, input.headSha);
      const body = `${input.body?.trim() ?? ""}\n\n${marker(m)}`.trim();
      if (existing) {
        await api(m, `/pulls/${existing.number}`, "PATCH", { title: input.title, body });
        return result(m, await inspectPull(m));
      }
      if (m.publishAttempted) throw new GitFailure("Previous PR creation has an uncertain outcome; no matching PR was found. Reconcile before retrying", "publish_uncertain");
      m.publishAttempted = true; save(m);
      try {
        const created = pull(m, (await api(m, "/pulls", "POST", { title: input.title, body, head: m.branch, base: m.baseBranch, draft: false })).data);
        m.prNumber = created.number; save(m);
      } catch (error) {
        // A definitive rejection is safe to retry after its cause is fixed.
        // Network errors and server failures retain the uncertain-write fence.
        if (error instanceof GitFailure && error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500) {
          m.publishAttempted = false; save(m);
        }
        const reconciled = await findPull(m);
        if (!reconciled) throw error;
      }
      return result(m, await inspectPull(m));
    }
    if (input.kind === "inspect") return result(m, await inspectPull(m));
    if (input.kind === "merge") {
      if (!input.approvedSha || input.headSha !== input.approvedSha) throw new GitFailure("Approval and validation must refer to the same SHA", "approval_required");
      const p = await inspectPull(m);
      if (p.merged) {
        if (p.headSha !== input.approvedSha) throw new GitFailure("PR was merged at a different head SHA", "head_changed");
        return result(m, p);
      }
      await assertClean(m, input.approvedSha);
      if (p.headSha !== input.approvedSha) throw new GitFailure("PR head changed since approval", "head_changed");
      if (p.state !== "open" || p.draft || p.mergeable !== true || p.mergeableState !== "clean" || p.checks !== "success" || p.reviewDecision === "changes_requested") {
        throw new GitFailure("PR is not ready to merge: checks, reviews or GitHub mergeability are blocking", "merge_blocked", p.checks === "pending" || p.mergeable === null);
      }
      const fresh = await findPull(m);
      if (!fresh || fresh.headSha !== input.approvedSha) throw new GitFailure("PR head changed since approval", "head_changed");
      if (fresh.state !== "open" || fresh.draft || fresh.mergeable !== true || fresh.mergeableState !== "clean") throw new GitFailure("GitHub no longer considers this PR ready to merge", "merge_blocked", true);
      let mergeError: unknown;
      try { await api(m, `/pulls/${p.number}/merge`, "PUT", { merge_method: "squash", sha: input.approvedSha }); }
      catch (error) { mergeError = error; }
      // A 2xx response and even merged:true are not the completion evidence.
      // Read the PR after both success and timeout to reconcile the side effect.
      const observed = await findPull(m);
      if (observed?.merged && observed.headSha === input.approvedSha) return result(m, observed);
      if (mergeError) throw mergeError;
      throw new GitFailure("GitHub has not confirmed the requested merge", "merge_unconfirmed", true);
    }
    throw new GitFailure("Unknown workflow Git operation", "invalid_input");
  };
  const operation = (input: WorkflowGitInput): Promise<WorkflowGitResult> => {
      const previous = locks.get(input.issueId) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(() => execute(input)).catch((error: unknown): WorkflowGitResult => ({
        ok: false, error: error instanceof Error ? error.message : String(error), reason: error instanceof GitFailure ? error.reason : "git_error", retryable: error instanceof GitFailure ? error.retryable : false,
      }));
      locks.set(input.issueId, next);
      void next.finally(() => { if (locks.get(input.issueId) === next) locks.delete(input.issueId); });
      return next;
  };
  const inputFor = (context: WorkflowGitContext, kind: WorkflowGitInput["kind"]): WorkflowGitInput => ({
    kind, operationId: context.operationId, issueId: context.issueId, projectPath: context.projectPath,
    remoteName: context.remote, baseBranch: context.baseBranch, workdir: context.workspace?.workdir,
    branch: context.workspace?.branch, headSha: context.workspace?.headSha, title: "KANAME development workflow",
  });
  const successful = (r: WorkflowGitResult): Extract<WorkflowGitResult, { ok: true }> => {
    if (!r.ok) throw new GitFailure(r.error, r.reason, r.retryable);
    return r;
  };
  const workspace = (r: WorkflowGitResult): WorkflowWorkspace => {
    const value = successful(r);
    return { workdir: value.workdir, branch: value.branch, baseSha: value.baseSha, headSha: value.headSha,
      repository: `${value.repository.owner}/${value.repository.name}` };
  };
  const prResult = (r: WorkflowGitResult): WorkflowPullRequest => {
    const value = successful(r).pr;
    if (!value) throw new GitFailure("GitHub did not return a PR", "missing_pr");
    if (value.state === "open" && value.checks === "unknown") throw new GitFailure("CI state could not be verified", "github_unknown", true);
    return { number: value.number, url: value.url, headSha: value.headSha, baseBranch: value.baseBranch, state: value.state,
      // `false` means a Git conflict. Policy blockers (pending checks/reviews)
      // remain in mergeableState so the engine waits instead of repairing a
      // nonexistent conflict. A draft never advertises readiness.
      mergeable: value.draft ? null : value.mergeable,
      checks: value.checks === "success" ? "passed" : value.checks === "failure" ? "failed" : "pending",
      reviewDecision: value.reviewDecision === "none" && value.mergeableState === "blocked" ? "required" : value.reviewDecision,
      checksReported: value.checksReported, changesRequestedReviewIds: value.changesRequestedReviewIds,
      feedback: value.feedback, mergeableState: value.mergeableState };
  };
  const owned = async (context: WorkflowGitContext): Promise<Manifest> => {
    if (!idValid(context.issueId) || !existsSync(manifestPath(context.issueId))) throw new GitFailure("Workflow worktree has not been prepared", "not_prepared");
    const m: Manifest = JSON.parse(readFileSync(manifestPath(context.issueId), "utf8"));
    await assertTarget(m, inputFor(context, "inspect"));
    return m;
  };
  return {
    operation,
    prepare: async (context) => workspace(await operation(inputFor(context, "prepare"))),
    checkpoint: async (context) => workspace(await operation({ ...inputFor(context, "checkpoint"), title: context.summary })),
    publish: async (context) => prResult(await operation({ ...inputFor(context, "publish"), title: context.title, body: context.body })),
    inspect: async (context) => {
      const r = prResult(await operation(inputFor(context, "inspect")));
      if (r.number !== context.pullRequest.number) throw new GitFailure("The saved PR identity has changed", "pr_mismatch");
      return r;
    },
    merge: async (context) => {
      const m = await owned(context);
      if (m.prNumber !== context.pullRequest.number) throw new GitFailure("The saved PR identity has changed", "pr_mismatch");
      return prResult(await operation({ ...inputFor(context, "merge"), headSha: context.validatedSha, approvedSha: context.approvedSha }));
    },
    verify: async (context) => { const m = await owned(context); await assertClean(m, context.expectedSha); },
    diff: async (context) => {
      const m = await owned(context);
      if (!context.workspace) throw new GitFailure("A workspace checkpoint is required", "not_prepared");
      const diff = await git(["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", m.baseSha, context.workspace.headSha, "--"], m.workdir);
      return diff.length > 1_000_000 ? `${diff.slice(0, 1_000_000)}\n[Diff truncated at 1 MB]` : diff;
    },
  };
}
