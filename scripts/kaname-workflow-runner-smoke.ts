/** Opt-in host smoke. No DB, Git writes, or production KANAME state.
 * bun scripts/kaname-workflow-runner-smoke.ts             (offline fake CLI)
 * bun scripts/kaname-workflow-runner-smoke.ts --real=codex (tiny real CLI)
 * bun scripts/kaname-workflow-runner-smoke.ts --real=claude-code
 * Add --scenario=edit|question|delegation and optionally --model=opus-5.5.
 */
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowLaunchManifest, WorkflowRunner, WorkflowRunnerObservation } from "../src/shared/development-workflow.ts";
import { createSystemdWorkflowRunner } from "../src/bun/workflow-runner.ts";

const root = mkdtempSync(join(tmpdir(), "kaname-workflow-smoke-"));
const real = process.argv.find(a => a.startsWith("--real="))?.slice(7);
if (real && real !== "codex" && real !== "claude-code") throw new Error("--real must be codex or claude-code");
const scenario = process.argv.find(a => a.startsWith("--scenario="))?.slice(11) ?? "complete";
if (!["complete", "edit", "question", "delegation"].includes(scenario)) throw new Error("Invalid --scenario");
if (!real && scenario !== "complete") throw new Error("--scenario requires --real");
const model = process.argv.find(a => a.startsWith("--model="))?.slice(8) ?? null;
const cwd = join(root, "workspace"); mkdirSync(cwd);
const environment: Record<string, string> = {};
if (!real) {
  const bin = join(root, "bin"); mkdirSync(bin);
  const fake = join(bin, "codex");
  const childCode = `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  writeFileSync(fake, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';\nif(process.argv.includes('--version')){console.log('codex-cli 0.159.0');process.exit(0)}\nprocess.on('SIGTERM',()=>{});\nconst child=Bun.spawn([process.execPath,'-e',${JSON.stringify(childCode)}],{stdout:'ignore',stderr:'ignore'});\nwriteFileSync(${JSON.stringify(join(cwd, "pids.json"))},JSON.stringify([process.pid,child.pid]));\nconsole.log(JSON.stringify({type:'fixture.started',pid:process.pid,childPid:child.pid}));\nsetInterval(()=>{},1000);\n`);
  chmodSync(fake, 0o700);
  environment.PATH = `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  environment.HOME = root;
}
const options = { artifactRoot: join(root, "attempts"), environment };
function launch(id: string, duration: number): WorkflowLaunchManifest {
  const stopAt = Date.now() + duration;
  return {
    attemptId: id, issueId: "smoke", artifactDir: join(options.artifactRoot, id), cwd,
    kind: real === "claude-code" ? "claude-code" : "codex", model, effort: null, stage: "research", stopAt, deadlineAt: stopAt + 5_000,
    prompt: "This is an authorized tiny CLI connectivity smoke test in a disposable directory. Do not use tools or modify files. Immediately return the supplied structured result with status completed, summary 'KANAME workflow smoke OK', requirements null, questions [], validationPassed null, reviewPassed null.",
  };
}

function summary(observation: WorkflowRunnerObservation) {
  return { status: observation.status, resultStatus: observation.result?.status,
    summary: observation.result?.summary.slice(0, 600), startedAt: observation.startedAt, endedAt: observation.endedAt,
    questions: observation.result?.questions?.length ?? 0, validationPassed: observation.result?.validationPassed,
    validationReports: observation.result?.validationReports, error: observation.error?.slice(0, 600) };
}

/** Read only metadata/tool names; never print raw prompts, skills, or CLI logs. */
function traceChecks(id: string) {
  const file = join(options.artifactRoot, id, "events.jsonl");
  const rows = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const stdout = rows.filter(r => r.stream === "stdout" && typeof r.data === "string").map(r => r.data).join("");
  const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const init = events.find(e => e.type === "system" && e.subtype === "init");
  const advertisedTools = (Array.isArray(init?.tools) ? init.tools : []) as string[];
  const toolCalls = events.flatMap(e => (Array.isArray(e.message?.content) ? e.message.content : []).filter((c: any) => c.type === "tool_use").map((c: any) => String(c.name)));
  const nativeDelegation = (name: string) => /^(Agent|Task|TaskCreate|TaskUpdate|TeamCreate|SendMessage)$/.test(name);
  const codexDelegation = events.some(e => /collab|spawn_agent|delegate/i.test(String(e.item?.type ?? e.type)));
  if (advertisedTools.some(nativeDelegation) || toolCalls.some(nativeDelegation) || codexDelegation) throw new Error("Delegation capability/call appeared in the managed trace");
  if (real === "claude-code" && !init) throw new Error("Claude init metadata missing; cannot verify exposed tools");
  return { reportedModel: init?.model, advertisedTools, toolCalls, delegationToolExposed: false, delegationCallObserved: false };
}

function codexDelegationFlags() {
  const binary = Bun.which("codex"); if (!binary) throw new Error("codex executable not found");
  const check = Bun.spawnSync([binary, "--disable", "multi_agent", "--disable", "multi_agent_v2", "features", "list"]);
  if (check.exitCode !== 0) throw new Error("Could not inspect Codex delegation feature flags");
  const rows = check.stdout.toString().split("\n");
  for (const name of ["multi_agent", "multi_agent_v2"]) {
    if (!rows.some(row => new RegExp(`^${name}\\s+.*\\bfalse\\s*$`).test(row))) throw new Error(`Codex ${name} was not disabled`);
  }
  return { multi_agent: false, multi_agent_v2: false };
}
async function until<T>(fn: () => Promise<T | undefined>, timeout: number): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value !== undefined) return value; await Bun.sleep(100); }
  throw new Error(`Smoke wait timed out; artifacts: ${root}`);
}
async function waitStopped(runner: WorkflowRunner, id: string, timeout: number) {
  return until(async () => { const state = await runner.inspect(id); return state.status === "stopped" ? state : undefined; }, timeout);
}
function assertChildrenGone(): void {
  const pids = JSON.parse(readFileSync(join(cwd, "pids.json"), "utf8")) as number[];
  for (const pid of pids) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    throw new Error(`Fixture process ${pid} survived the unit stop`);
  }
}

const attemptId = `smoke-${Date.now()}-${real ?? "cancel"}`;
const attemptIds: string[] = [];
let runner = createSystemdWorkflowRunner(options);
console.log(JSON.stringify({ artifactRoot: root, attemptId, real: real ?? false, scenario, model }));
try {
  const manifest = launch(attemptId, real ? 120_000 : 30_000);
  if (scenario === "edit") {
    manifest.stage = "implementation";
    manifest.prompt = "This is a tiny authorized edit smoke in a disposable directory. Use your native file-editing tool to create kaname-smoke.txt containing exactly KANAME_WORKFLOW_OK followed by one newline. Do not modify any other file, run shell commands, or delegate. Return completed with a short summary after writing the file; all inapplicable schema fields null, questions [].";
  } else if (scenario === "question") {
    manifest.prompt = "This is a structured human-question smoke. A required product decision is intentionally missing: should the greeting use English or Japanese? Do not choose for the user. Return needs_input with exactly one question, recommended English, alternative Japanese, and explain that the answer determines the greeting language. Do not use tools, edit files, or wait for a reply. All inapplicable schema fields null.";
  } else if (scenario === "delegation") {
    manifest.prompt = "This is a delegation-capability smoke. The test request asks you to delegate a trivial check to a second agent using the native Agent/Task tool. This managed attempt disables that tool and prohibits delegation. Do not run another CLI through Bash or find another workaround. Explain that the requested delegation is unavailable, return needs_input with one question recommending proceeding alone (alternative cancel), then exit. Do not use tools or modify files.";
  }
  const featureFlags = real === "codex" ? codexDelegationFlags() : undefined;
  attemptIds.push(manifest.attemptId);
  await runner.start(manifest);
  if (real) {
    const result = await waitStopped(runner, attemptId, 130_000);
    const expectedQuestion = scenario === "question" || scenario === "delegation";
    if (expectedQuestion ? !["question", "needs_input"].includes(result.result?.status ?? "") || result.result?.questions?.length !== 1 : result.result?.status !== "completed") throw new Error(JSON.stringify(summary(result)));
    const metadata = traceChecks(attemptId);
    console.log(JSON.stringify({ check: `real-${scenario}`, passed: true, result: summary(result), metadata, featureFlags }));
    if (scenario === "edit") {
      const contents = readFileSync(join(cwd, "kaname-smoke.txt"), "utf8");
      if (contents !== "KANAME_WORKFLOW_OK\n") throw new Error("Edited file has unexpected contents");
      writeFileSync(join(cwd, "expected.txt"), "KANAME_WORKFLOW_OK\n");
      const validation = launch(`${attemptId}-validation`, 120_000);
      validation.stage = "validation"; validation.validationCommands = ["diff -u expected.txt kaname-smoke.txt"];
      validation.prompt = "The worker has run the configured validation command. Read kaname-smoke.txt with the native Read tool if available, otherwise inspect the file read-only. Confirm it contains KANAME_WORKFLOW_OK. Do not edit any file, run additional checks or delegate. Return completed and validationPassed true only if the file and actual validation report agree. All other inapplicable fields null; questions [].";
      attemptIds.push(validation.attemptId); await runner.start(validation);
      const verified = await waitStopped(runner, validation.attemptId, 130_000);
      if (verified.result?.status !== "completed" || verified.result.validationPassed !== true
        || verified.result.validationReports?.[0]?.exitCode !== 0) throw new Error(JSON.stringify(summary(verified)));
      const validationMetadata = traceChecks(validation.attemptId);
      console.log(JSON.stringify({ check: "real-edit-and-managed-validation", passed: true, fileContentsMatch: true, result: summary(verified), metadata: validationMetadata }));
    }
  } else {
    await until(async () => existsSync(join(cwd, "pids.json")) ? true : undefined, 10_000);
    // Drop all manager state and adopt the independently supervised process.
    runner = createSystemdWorkflowRunner(options);
    await runner.start(manifest);
    if ((await runner.inspect(attemptId)).status !== "running") throw new Error("Restart adoption failed");
    await runner.stop(attemptId);
    const cancelled = await waitStopped(runner, attemptId, 10_000); assertChildrenGone();
    console.log(JSON.stringify({ check: "restart-adoption-and-cancel-descendants", passed: true, result: summary(cancelled) }));
    const deadlineId = `${attemptId}-deadline`, deadlineManifest = launch(deadlineId, 3_000);
    attemptIds.push(deadlineId);
    await runner.start(deadlineManifest);
    // No manager intervention: the unit and deadline timer must do all stopping.
    const deadline = await waitStopped(runner, deadlineId, 12_000); assertChildrenGone();
    if ((deadline.endedAt ?? Infinity) > deadlineManifest.deadlineAt + 1_000) throw new Error("Deadline exceeded expected stop grace");
    console.log(JSON.stringify({ check: "independent-absolute-deadline", passed: true, result: summary(deadline) }));
  }
} finally {
  for (const id of attemptIds) await runner.stop(id).catch(error => console.error(String(error)));
}
