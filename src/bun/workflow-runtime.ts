import path from "node:path";
import { db, dataDir, projects } from "./db.ts";
import { getGitHubPullMergeability, repoForDir } from "./github.ts";
import { isManagedWorkflowPull } from "./workflow-merge-guard.ts";
import { WorkflowEngine } from "./workflow-engine.ts";
import { createWorkflowGit } from "./workflow-git.ts";
import { createSystemdWorkflowRunner } from "./workflow-runner.ts";
import { createWorkflowApi } from "./workflow-api.ts";

let engine: WorkflowEngine | undefined;
let starting: Promise<void> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let handler: ReturnType<typeof createWorkflowApi> | undefined;

export function developmentWorkflowEngine(): WorkflowEngine {
  if (!engine) {
    const artifactRoot = path.join(dataDir, "development-attempts");
    engine = new WorkflowEngine(db, {
      artifactRoot,
      runner: createSystemdWorkflowRunner({ artifactRoot }),
      git: createWorkflowGit({ dataRoot: dataDir }),
      projectExists: projectPath => !!projects.get(projectPath),
    });
  }
  return engine;
}

/** Recovery completes before queued jobs can start. Detached workers survive
 * a management process restart; shutdown only disables this scheduler. */
export function startDevelopmentWorkflows(): Promise<void> {
  if (!starting) starting = (async () => {
    const current = developmentWorkflowEngine();
    await current.reconcile();
    interval = setInterval(() => {
      void current.tick().catch(error => console.error("[kaname:workflow] scheduler", error));
    }, 1000);
    interval.unref();
  })().catch(error => { starting = undefined; throw error; });
  return starting;
}
export function stopDevelopmentWorkflowScheduler(): void {
  clearInterval(interval); interval = undefined; starting = undefined;
}
export function hasDevelopmentWorkflowWork(): boolean { return engine?.hasWork() ?? false; }
export async function handleDevelopmentWorkflowRequest(req: Request): Promise<Response> {
  await startDevelopmentWorkflows();
  handler ??= createWorkflowApi(developmentWorkflowEngine());
  return handler(req);
}

/** Generic GitHub merge controls must not bypass managed SHA approval. The
 * protected identity is repository+PR, so another checkout cannot evade it. */
export async function isDevelopmentWorkflowPull(dir: string, number: number): Promise<boolean> {
  return isManagedWorkflowPull(dir, number, {
    issues: developmentWorkflowEngine().listIssues(), dataRoot: dataDir, resolveRepo: repoForDir,
    getPull: async (path, prNumber) => {
      const pull = await getGitHubPullMergeability({ dir: path, number: prNumber });
      if (!pull.ok) throw new Error(`Cannot verify workflow PR ownership: ${pull.error}`);
      return { headRef: pull.headRef, headRepo: pull.headRepo };
    },
  });
}
