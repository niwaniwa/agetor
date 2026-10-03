// Real authenticated KANAME gateway + built UI, in-memory runner/Git fakes.
// No CLI/provider calls, Git writes, production data or outside requests.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect as baseExpect, type Browser } from "@playwright/test";
import type { WorkflowAgentResult, WorkflowGit, WorkflowLaunchManifest, WorkflowPullRequest, WorkflowRunnerObservation } from "../src/shared/development-workflow.ts";

const expect = baseExpect.configure({ timeout: 20_000 });
const scratch = mkdtempSync(path.join(tmpdir(), "kaname-workflow-browser-"));
const projectPath = path.join(scratch, "project"); mkdirSync(projectPath);
const otherProjectPath = path.join(scratch, "other-project"); mkdirSync(otherProjectPath);
process.env.AGETOR_DATA_DIR = path.join(scratch, "data");
process.env.AGETOR_API_PORT = "0";
process.env.AGETOR_BACKGROUND_DISCOVERY = "0";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_SKIP_CLI_VERSION_FLOOR = "1";
const { db, projects } = await import("../src/bun/db.ts");
const { WorkflowEngine } = await import("../src/bun/workflow-engine.ts");
const { startApiServer, API_TOKEN } = await import("../src/bun/server.ts");
const { startWebServer } = await import("../src/bun/web-server.ts");
projects.upsert(projectPath, "Workflow smoke");
projects.upsert(otherProjectPath, "Workflow smoke other");
const states = new Map<string, WorkflowRunnerObservation>();
const asked = new Set<string>();
let starts = 0, merges = 0;
let pr: WorkflowPullRequest = { number: 42, url: "https://github.com/mock/fixture/pull/42", headSha: "b".repeat(40), baseBranch: "main", state: "open", mergeable: true, mergeableState: "clean", checks: "passed", reviewDecision: "none" };
const workspace = { workdir: projectPath, branch: "kaname/browser-smoke", baseSha: "a".repeat(40), headSha: "a".repeat(40), repository: "mock/fixture" };
const git: WorkflowGit = {
  async prepare() { return { ...workspace }; }, async checkpoint() { return { ...workspace, headSha: "b".repeat(40) }; },
  async publish() { return { ...pr }; }, async inspect() { return { ...pr }; },
  async merge() { merges++; pr = { ...pr, state: "merged" }; return { ...pr }; },
  async verify() {}, async diff() { return "diff --git a/counter.ts b/counter.ts\n+export const counter = 1;"; },
};
const runner = {
  async start(m: WorkflowLaunchManifest) {
    if (states.has(m.attemptId)) return;
    starts++;
    let result: WorkflowAgentResult;
    if (m.stage === "research" && !asked.has(m.issueId)) {
      asked.add(m.issueId); result = { status: "needs_input", summary: "Compatibility decision needed", questions: [{ question: "既存 API を維持しますか？", recommended: "維持する", alternatives: ["変更する"], impact: "既存クライアントの互換性" }] };
    } else if (m.stage === "research") result = { status: "completed", summary: "要件を整理しました", requirements: { purpose: "カウンターを追加", scope: "既存 API を維持", outOfScope: "認証", acceptanceCriteria: ["カウンターが1を返す"], approach: "既存構成を使う", assumptions: ["互換性を維持する"] } };
    else if (m.stage === "validation") result = { status: "completed", summary: "検証成功", validationPassed: true, validationReports: [{ command: "echo fixture-validation", exitCode: 0, startedAt: Date.now() - 1, endedAt: Date.now() }] } as WorkflowAgentResult;
    else result = { status: "completed", summary: "工程完了", reviewPassed: m.stage === "review" ? true : undefined };
    states.set(m.attemptId, { status: "stopped", startedAt: Date.now() - 10, endedAt: Date.now(), result, logs: `fixture CLI output: ${m.stage} completed` });
  },
  async inspect(id: string) { return states.get(id) ?? { status: "unknown" as const }; },
  async stop(id: string) { states.set(id, { status: "stopped", startedAt: Date.now(), endedAt: Date.now() }); },
};
let engine = new WorkflowEngine(db, { runner, git, artifactRoot: path.join(scratch, "artifacts"), projectExists: p => !!projects.get(p) });
engine.setProjectSettings(otherProjectPath, { remote: "secondary", model: "secondary-model", effort: "low" });
const core = startApiServer({ workflow: engine });
const web = startWebServer({ port: 0, dataDir: process.env.AGETOR_DATA_DIR!, staticDir: path.resolve(import.meta.dir, "../dist"), backendUrl: "http://127.0.0.1:" + core.port, backendToken: API_TOKEN });
const origin = "http://127.0.0.1:" + web.port;
let browser: Browser | undefined;
let captureFailure: (() => Promise<unknown>) | undefined;
const errors: string[] = [];
const timer = setInterval(() => void engine.tick().catch(e => errors.push(String(e))), 100);
try {
  assert.equal((await fetch("http://127.0.0.1:" + core.port + "/workflow/issues")).status, 401);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(20_000);
  captureFailure = () => page.screenshot({ path: path.join(scratch, "workflow-failure.png"), fullPage: true });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("Access token").fill(readFileSync(path.join(process.env.AGETOR_DATA_DIR!, "web-login-token"), "utf8").trim());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const skip = page.getByRole("button", { name: "Skip — I know my way around", exact: true });
  await skip.click();
  await page.getByTestId("development-workflows-button").click();
  await expect(page.getByRole("heading", { name: "開発ワークフロー", exact: true })).toBeVisible();
  const panel = page.getByTestId("development-workflows-page");
  await panel.getByRole("button", { name: "設定", exact: true }).click();
  await panel.getByLabel("プロジェクト", { exact: true }).selectOption(projectPath);
  await panel.getByLabel("モデル", { exact: true }).fill("test-model");
  await panel.getByLabel("Effort", { exact: true }).fill("low");
  await panel.getByLabel("検証コマンド（一行に一つ）").fill("echo fixture-validation");
  await panel.getByLabel("このプロジェクトで GitHub への push・PR 作成を有効にする").check();
  // A delayed save response must not replace another project's selected form.
  let releaseSave!: () => void, saveArrived!: () => void;
  const releasedSave = new Promise<void>(resolve => { releaseSave = resolve; });
  const serverSaved = new Promise<void>(resolve => { saveArrived = resolve; });
  await page.route("**/api/workflow/projects", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch(); saveArrived(); await releasedSave;
    await route.fulfill({ response });
  });
  await panel.getByRole("button", { name: "プロジェクト設定を保存", exact: true }).click();
  await serverSaved;
  await panel.getByLabel("プロジェクト", { exact: true }).selectOption(otherProjectPath);
  await expect(panel.getByLabel("モデル", { exact: true })).toHaveValue("secondary-model");
  releaseSave();
  await expect(panel.getByRole("status")).toContainText("保存しました");
  await expect(panel.getByLabel("Git remote", { exact: true })).toHaveValue("secondary");
  await page.unroute("**/api/workflow/projects");
  await panel.getByLabel("プロジェクト", { exact: true }).selectOption(projectPath);
  await expect(panel.getByLabel("モデル", { exact: true })).toHaveValue("test-model");
  await panel.getByLabel("タイトル（任意）").fill("ブラウザーからの依頼");
  await panel.getByLabel("実現したいこと", { exact: true }).fill("互換性を維持してカウンターを追加する");
  await panel.getByRole("button", { name: "Backlog に保存", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Ready にして開始", exact: true })).toBeVisible();
  assert.equal(starts, 0);
  await panel.getByRole("button", { name: "Ready にして開始", exact: true }).click();
  await expect(panel.getByText("既存 API を維持しますか？", { exact: true })).toBeVisible();
  const id = engine.listIssues()[0]!.id;
  // Recreate the manager state while a durable human question is outstanding.
  engine = new WorkflowEngine(db, { runner, git, artifactRoot: path.join(scratch, "artifacts"), projectExists: p => !!projects.get(p) });
  await engine.reconcile();
  await page.reload();
  await page.getByTestId("development-workflows-button").click();
  await panel.getByRole("button", { name: /ブラウザーからの依頼 · 調査/ }).click();
  await expect(panel.getByText("既存 API を維持しますか？", { exact: true })).toBeVisible();
  await panel.getByLabel("回答", { exact: true }).fill("維持する");
  await panel.getByRole("button", { name: "回答", exact: true }).click();
  await expect(panel.getByRole("button", { name: "承認して Squash マージ", exact: true })).toBeVisible();
  assert.equal(merges, 0);
  // Existing generic merge route cannot bypass the workflow gate.
  const bypass = await fetch("http://127.0.0.1:" + core.port + "/github/pull-merge", { method: "POST", headers: { authorization: "Bearer " + API_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ path: projectPath, number: 42, method: "squash" }) });
  assert.equal(bypass.status, 409);
  const autoMergeBypass = await fetch("http://127.0.0.1:" + core.port + "/github/pull-auto-merge", { method: "POST", headers: { authorization: "Bearer " + API_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ path: projectPath, number: 42, enable: true }) });
  assert.equal(autoMergeBypass.status, 409);
  await panel.getByRole("button", { name: "差分", exact: true }).click();
  await expect(panel.getByText(/export const counter = 1/)).toBeVisible();
  await panel.getByRole("button", { name: "実行ログ", exact: true }).click();
  await expect(panel.getByText("fixture CLI output: review completed", { exact: true })).toBeVisible();
  const validationAttempt = engine.getDetail(id).attempts.find(attempt => attempt.stage === "validation")!;
  await panel.getByLabel("実行ログの工程", { exact: true }).selectOption(validationAttempt.id);
  await expect(panel.getByText("fixture CLI output: validation completed", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "要件・対応", exact: true }).click();
  await expect(panel.getByText("カウンターが1を返す", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "承認して Squash マージ", exact: true })).toBeDisabled();
  await panel.getByLabel("この SHA の差分・検証結果を確認しました").check();
  await panel.getByRole("button", { name: "承認して Squash マージ", exact: true }).click();
  await expect.poll(() => engine.getDetail(id).issue.status).toBe("done");
  await expect(panel.getByText(/^Done · マージ確認/)).toBeVisible();
  await page.screenshot({ path: path.join(scratch, "workflow-done.png"), fullPage: true });
  assert.equal(merges, 1); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks: ["authenticated routes", "project settings", "delayed project save cannot overwrite another project", "Backlog is inert", "Ready to question", "reload and manager recovery", "answer resumes", "real validation evidence", "diff and historical logs", "generic merge bypass rejected", "SHA approval to Done"], starts, merges, screenshot: path.join(scratch, "workflow-done.png"), scratch }));
} catch (error) {
  await captureFailure?.().catch(() => {});
  console.error(`Browser smoke failed; artifacts: ${scratch}`);
  throw error;
} finally {
  clearInterval(timer); await browser?.close(); web.stop(true); core.stop(true); db.close();
}
