import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isManagedWorkflowPull } from "./workflow-merge-guard.ts";
import type { WorkflowMergeGuardDependencies } from "./workflow-merge-guard.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "kaname-merge-guard-")); roots.push(dataRoot);
  mkdirSync(path.join(dataRoot, "development-git"));
  const issue: WorkflowMergeGuardDependencies["issues"][number] = {
    id: "issue-one", projectPath: "/project", pullRequest: null,
    workspace: { workdir: "/worktree", branch: "kaname/issue-one", baseSha: "a".repeat(40), headSha: "b".repeat(40), repository: "owner/repo" },
  };
  let reads = 0;
  const deps: WorkflowMergeGuardDependencies = {
    dataRoot, issues: [issue],
    resolveRepo: async dir => dir === "/unrelated" ? { owner: "other", name: "repo" } : { owner: "OWNER", name: "REPO" },
    getPull: async () => { reads++; return { headRepo: "owner/repo", headRef: "kaname/issue-one" }; },
  };
  function manifest(extra: Record<string, unknown> = {}) {
    writeFileSync(path.join(dataRoot, "development-git", "issue-one.json"), JSON.stringify({ version: 1, issueId: issue.id, branch: "kaname/issue-one", repository: { owner: "owner", name: "repo", remoteHost: "github.com" }, ...extra }));
  }
  return { dataRoot, issue, deps, manifest, reads: () => reads };
}

test("stored repository and PR identity blocks generic merge from another checkout and case variation", async () => {
  const f = fixture();
  f.issue.pullRequest = { number: 7, url: "https://github.com/owner/repo/pull/7", headSha: "b".repeat(40), baseBranch: "main", state: "open", mergeable: true, checks: "passed", reviewDecision: "none" };
  expect(await isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).toBe(true);
  expect(f.reads()).toBe(0);
  expect(await isManagedWorkflowPull("/unrelated", 7, f.deps)).toBe(false);
  expect(f.reads()).toBe(0);
});

test("manifest PR number protects creation before the engine saves pullRequest", async () => {
  const f = fixture(); f.manifest({ prNumber: 7 });
  expect(f.issue.pullRequest).toBeNull();
  expect(await isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).toBe(true); expect(f.reads()).toBe(0);
  // Manifest ownership also survives the absence of the workspace projection.
  f.issue.workspace = null;
  expect(await isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).toBe(true);
});

test("lost create response before either PR number is stored is identified by owned branch and repository", async () => {
  const f = fixture(); f.manifest({ publishAttempted: true });
  expect(await isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).toBe(true); expect(f.reads()).toBe(1);
  f.issue.workspace = null;
  expect(await isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).toBe(true); expect(f.reads()).toBe(2);
});

test("unrelated PRs and fork head branches are not claimed by a workflow marker or a matching branch name alone", async () => {
  const f = fixture(); f.manifest();
  f.deps.getPull = async () => ({ headRepo: "owner/repo", headRef: "manual-change" });
  expect(await isManagedWorkflowPull("/alternate-checkout", 8, f.deps)).toBe(false);
  f.deps.getPull = async () => ({ headRepo: "someone-else/repo", headRef: "kaname/issue-one" });
  expect(await isManagedWorkflowPull("/alternate-checkout", 8, f.deps)).toBe(false);
});

test("unknown PR identity and failed GitHub reads fail closed for repositories with owned work", async () => {
  const f = fixture(); f.manifest();
  f.deps.getPull = async () => { throw new Error("GitHub unavailable"); };
  await expect(isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).rejects.toThrow("GitHub unavailable");
  f.deps.getPull = async () => ({ headRepo: null, headRef: "kaname/issue-one" });
  await expect(isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).rejects.toThrow("Cannot verify PR ownership");
});

test("corrupt ownership state cannot turn a managed PR into an unguarded generic merge", async () => {
  const f = fixture();
  writeFileSync(path.join(f.dataRoot, "development-git", "issue-one.json"), "{broken");
  await expect(isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).rejects.toThrow("Cannot verify workflow Git ownership");
  f.issue.workspace = null;
  await expect(isManagedWorkflowPull("/alternate-checkout", 7, f.deps)).rejects.toThrow("Cannot verify workflow Git ownership");
  expect(f.reads()).toBe(0);
});

test("unrelated repositories need no PR inspection, even when another workflow manifest is corrupt", async () => {
  const f = fixture();
  writeFileSync(path.join(f.dataRoot, "development-git", "issue-one.json"), "{broken");
  expect(await isManagedWorkflowPull("/unrelated", 7, f.deps)).toBe(false); expect(f.reads()).toBe(0);
});
