import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DevelopmentIssue } from "../shared/development-workflow.ts";

type IssueIdentity = Pick<DevelopmentIssue, "id" | "projectPath" | "workspace" | "pullRequest">;
export interface WorkflowMergeGuardDependencies {
  issues: readonly IssueIdentity[];
  dataRoot: string;
  resolveRepo(dir: string): Promise<{ owner: string; name: string } | null>;
  getPull(dir: string, number: number): Promise<{ headRef: string; headRepo: string | null }>;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const repoKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();

/** Guard all generic merge paths, including the interval after GitHub creates
 * a PR but before the engine records its result. Ownership comes from server
 * state and the frozen Git manifest, never from a marker in agent-authored text.
 * Failed PR/ownership reads throw so callers cannot treat uncertainty as an
 * unmanaged PR and send an unguarded merge. */
export async function isManagedWorkflowPull(dir: string, number: number, deps: WorkflowMergeGuardDependencies): Promise<boolean> {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("A positive PR number is required");
  if (deps.issues.length === 0) return false;
  const repo = await deps.resolveRepo(dir);
  if (!repo) {
    // The corresponding GitHub merge helper cannot resolve an alternate
    // checkout either. Still protect a known path without remote discovery.
    return deps.issues.some(issue => (issue.projectPath === dir || issue.workspace?.workdir === dir) && issue.pullRequest?.number === number);
  }
  const target = repoKey(repo.owner, repo.name);
  const candidates: Array<{ branch: string; number?: number }> = [];
  for (const issue of deps.issues) {
    if (issue.workspace?.repository.toLowerCase() === target) {
      candidates.push({ branch: issue.workspace.branch, number: issue.pullRequest?.number });
    }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(issue.id)) throw new Error("Cannot verify workflow Git ownership: invalid issue identity");
    const file = path.join(deps.dataRoot, "development-git", `${issue.id}.json`);
    try {
      if (!existsSync(file)) continue;
      const manifest = record(JSON.parse(readFileSync(file, "utf8")));
      const repository = record(manifest.repository);
      if (manifest.version !== 1 || manifest.issueId !== issue.id || typeof manifest.branch !== "string" ||
        !manifest.branch || typeof repository.owner !== "string" || typeof repository.name !== "string") {
        throw new Error("invalid frozen Git manifest");
      }
      if (repoKey(repository.owner, repository.name) === target) {
        if (manifest.prNumber !== undefined && (!Number.isSafeInteger(manifest.prNumber) || Number(manifest.prNumber) <= 0)) throw new Error("invalid saved PR identity");
        candidates.push({ branch: manifest.branch, number: manifest.prNumber as number | undefined });
      }
    } catch {
      const source = issue.workspace?.repository.toLowerCase()
        ?? await deps.resolveRepo(issue.projectPath).then(value => value ? repoKey(value.owner, value.name) : null);
      if (source === target || source === null) throw new Error("Cannot verify workflow Git ownership; repair its saved state before merging");
    }
  }
  if (candidates.some(candidate => candidate.number === number)) return true;
  if (!candidates.length) return false;
  const pull = await deps.getPull(dir, number);
  if (!pull.headRef || !pull.headRepo) throw new Error("Cannot verify PR ownership; GitHub did not identify its head branch and repository");
  return pull.headRepo.toLowerCase() === target && candidates.some(candidate => candidate.branch === pull.headRef);
}
