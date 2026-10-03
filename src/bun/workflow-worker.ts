/** One attempt, one systemd unit. This module must never import management DB code. */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkflowAgentResult, WorkflowLaunchManifest } from "../shared/development-workflow.ts";
import { assertWorkflowAttemptId, parseWorkflowAgentResult, VERIFIED_WORKFLOW_CLI_VERSIONS, WORKFLOW_RESULT_SCHEMA, workflowCliCommand, workflowPrompt } from "./workflow-runner-protocol.ts";

export function writeWorkflowReceipt(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

export function readWorkflowManifest(path: string): WorkflowLaunchManifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as WorkflowLaunchManifest;
  assertWorkflowAttemptId(m.attemptId);
  if (resolve(dirname(path)) !== resolve(m.artifactDir) || !isAbsolute(m.cwd)
    || !["research", "implementation", "validation", "review"].includes(m.stage)
    || !["codex", "claude-code"].includes(m.kind) || typeof m.prompt !== "string"
    || !Number.isFinite(m.stopAt) || !Number.isFinite(m.deadlineAt) || m.stopAt >= m.deadlineAt
    || (m.validationCommands !== undefined && (!Array.isArray(m.validationCommands) || !m.validationCommands.every(c => typeof c === "string")))) {
    throw new Error("Invalid workflow launch manifest");
  }
  return m;
}

export function currentWorkflowCgroup(): string | null {
  try { return readFileSync("/proc/self/cgroup", "utf8").split("\n").find(l => l.startsWith("0::/"))?.slice(3) ?? null; }
  catch { return null; }
}

export function recordWorkflowUnitExit(manifestPath: string): void {
  const m = readWorkflowManifest(manifestPath);
  writeWorkflowReceipt(join(m.artifactDir, "unit-exit.json"), {
    endedAt: Date.now(), controlGroup: currentWorkflowCgroup(),
    serviceResult: process.env.SERVICE_RESULT ?? "unknown",
    exitCode: process.env.EXIT_CODE ?? null, exitStatus: process.env.EXIT_STATUS ?? null,
  });
}

function failure(summary: string): WorkflowAgentResult { return { status: "failed", summary }; }
function permissionQuestion(summary: string): WorkflowAgentResult {
  return { status: "needs_input", summary, questions: [{
    question: "This attempt could not use a required tool. How should the workflow proceed?",
    recommended: "Provide the missing information or an approved alternative, then explicitly resume.",
    alternatives: ["Change the requirements", "Cancel this workflow"], impact: summary,
  }] };
}

export async function runWorkflowWorker(manifestPath: string): Promise<number> {
  const m = readWorkflowManifest(manifestPath);
  const path = (name: string) => join(m.artifactDir, name);
  let sequence = 0;
  let validationReports: WorkflowAgentResult["validationReports"];
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const log = (stream: string, data: unknown) => appendFileSync(path("events.jsonl"), `${JSON.stringify({ sequence: ++sequence, at: Date.now(), stream, data })}\n`, { mode: 0o600 });
  const finish = (result: WorkflowAgentResult, exitCode: number) => {
    if (validationReports) result.validationReports = validationReports;
    writeWorkflowReceipt(path("result.json"), { result, exitCode, completedAt: Date.now() });
    return exitCode;
  };
  if (existsSync(path("started.json"))) throw new Error("This attempt already started; refusing to run the CLI twice");
  if (existsSync(path("stop-request.json")) || Date.now() >= m.stopAt) return finish(failure("Attempt stopped before CLI launch."), 124);
  writeFileSync(path("started.json"), JSON.stringify({ startedAt: Date.now(), controlGroup: currentWorkflowCgroup() }), { flag: "wx", mode: 0o600 });
  // This is secondary to the independent systemd timer and RuntimeMaxSec.
  const terminate = (reason: string, code: number) => { finish(failure(reason), code); process.exit(code); };
  const timeout = setTimeout(() => terminate("Attempt deadline reached.", 124), Math.max(1, m.stopAt - Date.now()));
  const onTerm = () => terminate("Attempt stopped by supervisor.", 143);
  process.once("SIGTERM", onTerm);
  try {
    const binary = m.kind === "codex" ? Bun.which("codex") : Bun.which("claude");
    if (!binary) return finish(failure(`${m.kind} executable not found.`), 127);
    const versionChild = Bun.spawn([binary, "--version"], { cwd: m.cwd, stdout: "pipe", stderr: "pipe" });
    const [versionOut, versionErr, versionCode] = await Promise.all([new Response(versionChild.stdout).text(), new Response(versionChild.stderr).text(), versionChild.exited]);
    const version = `${versionOut}\n${versionErr}`.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    if (versionCode !== 0 || !(VERIFIED_WORKFLOW_CLI_VERSIONS[m.kind] as readonly string[]).includes(version ?? "")) {
      return finish(failure(`Unverified ${m.kind} version ${version ?? "unknown"}; verify delegation-disable and structured-output flags before enabling this version.`), 78);
    }
    writeFileSync(path("schema.json"), JSON.stringify(WORKFLOW_RESULT_SCHEMA), { mode: 0o600 });
    let validationPassed: boolean | undefined;
    let validationContext = "";
    if (m.stage === "validation") {
      if (!m.validationCommands?.length) return finish(permissionQuestion("No validation commands are configured."), 0);
      const reports = validationReports = [] as NonNullable<WorkflowAgentResult["validationReports"]>;
      for (const command of m.validationCommands) {
        const startedAt = Date.now();
        log("validation.status", { command, status: "started", startedAt });
        // These are explicitly configured project commands, not LLM-generated shell text.
        const child = Bun.spawn(["/bin/sh", "-lc", command], { cwd: m.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
        const [, , exitCode] = await Promise.all([consume(child.stdout, "validation.stdout"), consume(child.stderr, "validation.stderr"), child.exited]);
        reports.push({ command, exitCode, startedAt, endedAt: Date.now() });
        writeWorkflowReceipt(path("validation.json"), reports);
        log("validation.status", { ...reports.at(-1), status: "exited" });
      }
      validationPassed = reports.every(r => r.exitCode === 0);
      validationContext = `\nActual configured validation command results (authoritative): ${JSON.stringify(reports)}\n`;
      if (!validationPassed) return finish({ status: "failed", summary: `Validation failed: ${reports.filter(r => r.exitCode !== 0).map(r => `${r.command} (exit ${r.exitCode})`).join(", ")}`, validationPassed: false }, 1);
    }
    if (existsSync(path("stop-request.json")) || Date.now() >= m.stopAt) return finish(failure("Attempt stopped before CLI launch."), 124);
    let claudeResult: Record<string, unknown> | undefined;
    let codexFinal: string | undefined;
    let denied = false;
    let providerError = "";
    function event(line: string) {
      try {
        const e = JSON.parse(line) as Record<string, any>;
        if (e.type === "result") claudeResult = e;
        if (Array.isArray(e.permission_denials) && e.permission_denials.length) denied = true;
        if (e.type === "item.completed" && e.item?.type === "agent_message") codexFinal = e.item.text;
        if (e.type === "error" || e.type === "turn.failed" || e.is_error === true) providerError += JSON.stringify(e).slice(0, 16_000);
      } catch { /* Raw/non-JSON CLI output is still retained in events. */ }
    }
    const child = Bun.spawn(workflowCliCommand(m, binary, path("schema.json"), path("last-message.json")), {
      cwd: m.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    child.stdin.write(workflowPrompt(m) + validationContext);
    child.stdin.end();
    const output = Promise.all([consume(child.stdout, "stdout", event), consume(child.stderr, "stderr")]);
    const exitCode = await child.exited;
    // A background descendant can inherit a pipe after the CLI exits. Do not
    // let that keep the worker alive; unit shutdown will terminate its scope.
    const drainTimeout = setTimeout(() => { for (const reader of readers) void reader.cancel().catch(() => undefined); }, 1_000);
    try { await output; } finally { clearTimeout(drainTimeout); }
    let result: WorkflowAgentResult;
    if (denied) result = permissionQuestion("The CLI denied a required tool or permission; its process has exited.");
    else if (exitCode !== 0 || claudeResult?.is_error === true || providerError) {
      result = /quota|rate.?limit|usage.?limit|429/i.test(providerError + JSON.stringify(claudeResult ?? {}))
        ? { status: "quota", summary: "The CLI reported a provider usage limit. Explicit resume is required." }
        : failure(`CLI failed (exit ${exitCode}). ${providerError.slice(0, 3000)}`);
    } else {
      try {
        const raw = m.kind === "codex"
          ? JSON.parse(existsSync(path("last-message.json")) ? readFileSync(path("last-message.json"), "utf8") : codexFinal ?? "")
          : claudeResult?.structured_output ?? JSON.parse(String(claudeResult?.result ?? ""));
        result = parseWorkflowAgentResult(raw);
      } catch (error) { result = failure(`CLI did not produce a valid structured result: ${String(error)}`); }
    }
    if (validationPassed !== undefined) result.validationPassed = validationPassed && result.validationPassed !== false;
    return finish(result, exitCode);

    async function consume(stream: ReadableStream<Uint8Array>, label: string, onLine?: (line: string) => void) {
      const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
      readers.add(reader);
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          const chunk = decoder.decode(value, { stream: true }); log(label, chunk);
          if (onLine) {
            pending += chunk;
            let index: number;
            while ((index = pending.indexOf("\n")) !== -1) { onLine(pending.slice(0, index)); pending = pending.slice(index + 1); }
            if (pending.length > 2_000_000) { onLine(pending); pending = ""; }
          }
        }
        if (pending) onLine?.(pending);
      } finally { readers.delete(reader); reader.releaseLock(); }
    }
  } catch (error) { log("worker.error", String(error)); return finish(failure(String(error)), 1); }
  finally { clearTimeout(timeout); process.removeListener("SIGTERM", onTerm); }
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--record-stop") { recordWorkflowUnitExit(process.argv[3]!); }
    else process.exitCode = await runWorkflowWorker(process.argv[2]!);
  } catch (error) { console.error(error); process.exitCode = 1; }
}
