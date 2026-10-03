import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WorkflowLaunchManifest } from "../shared/development-workflow.ts";
import { createSystemdWorkflowRunner, workflowSystemdExec } from "./workflow-runner.ts";
import { parseWorkflowAgentResult, workflowCalendarDeadline, workflowCliCommand, workflowUnitNames } from "./workflow-runner-protocol.ts";
import { CLAUDE_MODEL_FLAG, toClaudeModelArg } from "../shared/claude-model-arg.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "kaname-runner-test-")); roots.push(root);
  const manifest: WorkflowLaunchManifest = {
    attemptId: "attempt-1", issueId: "issue-1", stage: "implementation", cwd: root,
    artifactDir: join(root, "attempt-1"), kind: "codex", model: null, effort: null,
    prompt: "Do a tiny offline test", stopAt: 100_000, deadlineAt: 105_000,
  };
  const states = new Map<string, { active: string; group: string }>();
  const calls: string[][] = [];
  let unavailable = false; let empty: boolean | null = true;
  async function command(argv: string[]) {
    calls.push(argv);
    if (unavailable) return { code: 1, stdout: "", stderr: "Failed to connect to bus" };
    if (argv[0] === "systemctl" && argv[2] === "show") {
      const s = states.get(argv[3]!);
      return { code: s ? 0 : 4, stdout: s ? `LoadState=loaded\nActiveState=${s.active}\nSubState=running\nControlGroup=${s.group}\nResult=success\n` : "LoadState=not-found\nActiveState=inactive\n", stderr: "" };
    }
    if (argv[0] === "systemd-run") {
      const name = argv.find(a => a.startsWith("--unit="))!.slice(7);
      if (argv.some(a => a.startsWith("--on-calendar="))) states.set(name.replace(/\.service$/, ".timer"), { active: "active", group: "" });
      else states.set(name, { active: "active", group: `/user.slice/${name}` });
    }
    if (argv[0] === "systemctl" && argv[2] === "stop") states.set(argv[3]!, { active: "inactive", group: "" });
    return { code: 0, stdout: "", stderr: "" };
  }
  const options = { artifactRoot: root, command, now: () => 10_000, cgroupEmpty: () => empty };
  const runner = createSystemdWorkflowRunner(options);
  return { root, manifest, states, calls, options, runner, setUnavailable: (v: boolean) => unavailable = v, setEmpty: (v: boolean | null) => empty = v };
}

describe("workflow systemd supervisor", () => {
  test("arms an absolute independent timer before launching a control-group service", async () => {
    const s = setup(); await s.runner.start(s.manifest);
    const run = s.calls.filter(c => c[0] === "systemd-run"); expect(run).toHaveLength(2);
    expect(run[0]).toContain("--on-calendar=1970-01-01 00:01:40.000 UTC");
    expect(run[0]).toContain(workflowUnitNames(s.manifest.attemptId).service);
    expect(run[1]).toContain("--property=Type=exec"); expect(run[1]).toContain("--property=Restart=no");
    expect(run[1]).toContain("--property=KillMode=control-group"); expect(run[1]).toContain("--property=TimeoutStopSec=5s");
    expect(run[1]).toContain("--property=RuntimeMaxSec=90s");
    expect(run[1]!.some(a => a.startsWith("--property=ExecStopPost=:") && a.includes("--record-stop"))).toBe(true);
    expect(run[1]).not.toContain("--scope"); expect(run[1]).not.toContain("--collect");
    expect(JSON.parse(readFileSync(join(s.manifest.artifactDir, "manifest.json"), "utf8"))).toEqual(s.manifest);
  });
  test("manager restart adopts a live attempt and never starts a second CLI", async () => {
    const s = setup(); await s.runner.start(s.manifest);
    const recovered = createSystemdWorkflowRunner(s.options); await recovered.start(s.manifest);
    expect(s.calls.filter(c => c[0] === "systemd-run")).toHaveLength(2);
    expect((await recovered.inspect(s.manifest.attemptId)).status).toBe("running");
  });
  test("a final result alone does not prove the child scope exited", async () => {
    const s = setup(); await s.runner.start(s.manifest); const dir = s.manifest.artifactDir;
    writeFileSync(join(dir, "started.json"), JSON.stringify({ startedAt: 11_000, controlGroup: "/test/attempt" }));
    writeFileSync(join(dir, "result.json"), JSON.stringify({ result: { status: "completed", summary: "Done" } }));
    expect((await s.runner.inspect(s.manifest.attemptId)).status).toBe("running");
    s.states.set(workflowUnitNames(s.manifest.attemptId).service, { active: "inactive", group: "" });
    writeFileSync(join(dir, "unit-exit.json"), JSON.stringify({ endedAt: 13_000, controlGroup: "/test/attempt" }));
    s.setEmpty(false); expect((await s.runner.inspect(s.manifest.attemptId)).status).toBe("unknown");
    s.setEmpty(null); expect((await s.runner.inspect(s.manifest.attemptId)).status).toBe("unknown");
    s.setEmpty(true); expect(await s.runner.inspect(s.manifest.attemptId)).toMatchObject({ status: "stopped", startedAt: 11_000, endedAt: 13_000, result: { status: "completed" } });
    const report = [{ command: "exit 7", exitCode: 7, startedAt: 11_001, endedAt: 11_100 }];
    writeFileSync(join(dir, "validation.json"), JSON.stringify(report));
    writeFileSync(join(dir, "result.json"), JSON.stringify({ result: { status: "completed", summary: "Done", validationReports: [{ command: "invented", exitCode: 0, startedAt: 0, endedAt: 1 }] } }));
    expect((await s.runner.inspect(s.manifest.attemptId)).result?.validationReports).toEqual(report);
    writeFileSync(join(dir, "result.json"), "corrupt result");
    expect(await s.runner.inspect(s.manifest.attemptId)).toMatchObject({ status: "stopped", result: { status: "failed" } });
  });
  test("bus failure retains unknown state, never fabricates cancellation", async () => {
    const s = setup(); await s.runner.start(s.manifest); s.setUnavailable(true);
    expect((await s.runner.inspect(s.manifest.attemptId)).status).toBe("unknown");
    await expect(s.runner.stop(s.manifest.attemptId)).rejects.toThrow("Cannot inspect systemd unit");
    expect(existsSync(join(s.manifest.artifactDir, "unit-exit.json"))).toBe(false);
  });
  test("stop after a pre-dispatch crash proves no execution and prevents delayed launch", async () => {
    const s = setup(); mkdirSync(s.manifest.artifactDir);
    writeFileSync(join(s.manifest.artifactDir, "manifest.json"), JSON.stringify(s.manifest));
    expect((await s.runner.inspect(s.manifest.attemptId)).status).toBe("unknown");
    await s.runner.stop(s.manifest.attemptId); await s.runner.start(s.manifest);
    expect(await s.runner.inspect(s.manifest.attemptId)).toMatchObject({ status: "stopped", startedAt: 10_000, endedAt: 10_000 });
    expect(s.calls.some(c => c[0] === "systemd-run")).toBe(false);
  });
  test("a reservation cancelled before manifest creation gets a safe no-launch tombstone", async () => {
    const s = setup();
    expect((await s.runner.inspect(s.manifest.attemptId)).status).toBe("unknown");
    await s.runner.stop(s.manifest.attemptId);
    expect(await s.runner.inspect(s.manifest.attemptId)).toMatchObject({ status: "stopped", startedAt: 10_000, endedAt: 10_000 });
    await s.runner.start(s.manifest);
    expect(s.calls.some(c => c[0] === "systemd-run")).toBe(false);
  });
  test("an expired reservation never dispatches a service", async () => {
    const s = setup(); s.manifest.stopAt = 9_000; s.manifest.deadlineAt = 14_000;
    await s.runner.start(s.manifest); expect(await s.runner.inspect(s.manifest.attemptId)).toMatchObject({ status: "stopped", startedAt: 10_000, endedAt: 10_000 });
    expect(s.calls.some(c => c[0] === "systemd-run")).toBe(false);
  });
  test("terminal artifacts survive unit garbage collection and prohibit re-execution", async () => {
    const s = setup(); await s.runner.start(s.manifest); s.states.clear();
    writeFileSync(join(s.manifest.artifactDir, "started.json"), JSON.stringify({ startedAt: 11_000, controlGroup: "/old/scope" }));
    writeFileSync(join(s.manifest.artifactDir, "unit-exit.json"), JSON.stringify({ endedAt: 12_000, controlGroup: "/old/scope" }));
    const recovered = createSystemdWorkflowRunner(s.options); await recovered.start(s.manifest);
    expect(s.calls.filter(c => c[0] === "systemd-run")).toHaveLength(2);
    expect((await recovered.inspect(s.manifest.attemptId)).status).toBe("stopped");
  });
  test("rejects changed manifests, path traversal, and shell-like systemd interpolation", async () => {
    const s = setup(); await s.runner.start(s.manifest);
    await expect(s.runner.start({ ...s.manifest, prompt: "other" })).rejects.toThrow("immutable manifest");
    await expect(s.runner.start({ ...s.manifest, attemptId: "../escape" })).rejects.toThrow("Invalid workflow attempt");
    expect(workflowSystemdExec(["/bin/bun", "a b/$HOME/%x"])).toBe(':"/bin/bun" "a b/$HOME/%%x"');
  });
});

describe("workflow CLI protocol", () => {
  test("legacy and workflow adapters share canonical Claude model aliases", () => {
    for (const [friendly, canonical] of Object.entries(CLAUDE_MODEL_FLAG)) expect(toClaudeModelArg(friendly)).toBe(canonical);
    expect(toClaudeModelArg("claude-future-model")).toBe("claude-future-model"); expect(toClaudeModelArg("opus")).toBe("opus");
    const m = { ...setup().manifest, kind: "claude-code" as const, model: "opus-5.5" };
    const command = workflowCliCommand(m, "/bin/claude", "/schema", "/last");
    expect(command[command.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  });
  test("absolute deadline is accepted by the real systemd calendar parser", () => {
    const spec = workflowCalendarDeadline(Date.UTC(2099, 9, 2, 19, 5, 17, 371));
    expect(spec).toBe("2099-10-02 19:05:17.371 UTC");
    if (!Bun.which("systemd-analyze")) return; // Non-Linux development hosts have no systemd.
    const parsed = Bun.spawnSync(["systemd-analyze", "calendar", spec]);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout.toString()).toContain("2099-10-02 19:05:17.371000 UTC");
  });
  test("both supported CLIs explicitly disable internal delegation and user extension configuration", () => {
    const m = setup().manifest;
    const codex = workflowCliCommand(m, "/bin/codex", "/schema", "/last");
    expect(codex).toContain("multi_agent"); expect(codex).toContain("multi_agent_v2"); expect(codex).toContain("--ignore-user-config"); expect(codex).toContain("agents.enabled=false");
    const claude = workflowCliCommand({ ...m, kind: "claude-code" }, "/bin/claude", "/schema", "/last");
    expect(claude).toContain("--safe-mode"); expect(claude).toContain("Agent,Task,TaskCreate,TaskUpdate,TeamCreate,SendMessage,AskUserQuestion"); expect(claude).toContain("--strict-mcp-config");
  });
  test("structured questions require question data; review changes preserve their status", () => {
    expect(() => parseWorkflowAgentResult({ status: "needs_input", summary: "Ask" })).toThrow("requires a question");
    expect(parseWorkflowAgentResult({ status: "changes_requested", summary: "Fix bug" })).toEqual({ status: "changes_requested", summary: "Fix bug", reviewPassed: false });
    expect(parseWorkflowAgentResult({ status: "completed", summary: "Claimed success", validationReports: [{ command: "invented" }] }).validationReports).toBeUndefined();
  });
});

describe("DB-free worker with offline CLI fixtures", () => {
  async function workerFixture(mode: "success" | "denied" | "unverified" | "validation-failure" | "validation-success" | "claude-success" | "claude-denied") {
    const s = setup(); const bin = join(s.root, "bin"); mkdirSync(bin); mkdirSync(s.manifest.artifactDir);
    const claude = mode.startsWith("claude-"); if (claude) s.manifest.kind = "claude-code";
    const fake = join(bin, claude ? "claude" : "codex");
    writeFileSync(fake, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nif(process.argv.includes('--version')){console.log('${claude ? "2.1.285 (Claude Code)" : `codex-cli ${mode === "unverified" ? "9.9.9" : "0.159.0"}`}');process.exit(0)}\nwriteFileSync(${JSON.stringify(join(s.root, "cli-called"))},'yes');\nconst output={status:'completed',summary:'Offline result',requirements:null,questions:[],validationPassed:null,reviewPassed:null};\n${claude ? "" : "writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(output));"}\nconsole.log(JSON.stringify(${mode.endsWith("denied") ? "{type:'result',permission_denials:[{tool_name:'Bash'}]}" : claude ? "{type:'result',is_error:false,structured_output:output}" : "{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}}"}));\n`);
    chmodSync(fake, 0o700);
    s.manifest.stopAt = Date.now() + 15_000; s.manifest.deadlineAt = s.manifest.stopAt + 5000;
    if (mode.startsWith("validation-")) { s.manifest.stage = "validation"; s.manifest.validationCommands = [mode === "validation-failure" ? "exit 7" : "exit 0"]; }
    const manifestPath = join(s.manifest.artifactDir, "manifest.json"); writeFileSync(manifestPath, JSON.stringify(s.manifest));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "workflow-worker.ts"), manifestPath], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: s.root }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    const receipt = JSON.parse(readFileSync(join(s.manifest.artifactDir, "result.json"), "utf8"));
    return { ...s, code, stderr, receipt };
  }
  test("writes structured final result and append-only logs without a management database", async () => {
    const s = await workerFixture("success"); expect(s.code).toBe(0); expect(s.receipt.result.status).toBe("completed");
    expect(existsSync(join(s.manifest.artifactDir, "events.jsonl"))).toBe(true);
    expect(existsSync(join(s.root, ".kaname"))).toBe(false);
  });
  test("permission denial becomes an exited human question", async () => {
    const s = await workerFixture("denied"); expect(s.receipt.result.status).toBe("needs_input"); expect(s.receipt.result.questions.length).toBe(1);
  });
  test("Claude stream-json structured_output becomes the final result", async () => {
    const s = await workerFixture("claude-success"); expect(s.code).toBe(0); expect(s.receipt.result.status).toBe("completed");
  });
  test("Claude permission_denials become a human question even without structured output", async () => {
    const s = await workerFixture("claude-denied"); expect(s.code).toBe(0); expect(s.receipt.result.status).toBe("needs_input");
  });
  test("unverified CLI versions fail closed before any agent prompt", async () => {
    const s = await workerFixture("unverified"); expect(s.code).toBe(78); expect(s.receipt.result.summary).toContain("Unverified"); expect(existsSync(join(s.root, "cli-called"))).toBe(false);
  });
  test("actual validation failure cannot be overridden by a model success claim", async () => {
    const s = await workerFixture("validation-failure"); expect(s.receipt.result.validationPassed).toBe(false); expect(s.receipt.result.status).toBe("failed");
    expect(JSON.parse(readFileSync(join(s.manifest.artifactDir, "validation.json"), "utf8"))[0].exitCode).toBe(7);
    expect(s.receipt.result.validationReports[0]).toMatchObject({ command: "exit 7", exitCode: 7 });
    expect(readFileSync(join(s.manifest.artifactDir, "events.jsonl"), "utf8")).toContain('"stream":"validation.status"');
    expect(existsSync(join(s.root, "cli-called"))).toBe(false);
  });
  test("successful validation includes the worker's actual command receipts", async () => {
    const s = await workerFixture("validation-success");
    expect(s.receipt.result.status).toBe("completed"); expect(s.receipt.result.validationPassed).toBe(true);
    expect(s.receipt.result.validationReports).toHaveLength(1);
    expect(s.receipt.result.validationReports[0]).toMatchObject({ command: "exit 0", exitCode: 0 });
    expect(s.receipt.result.validationReports[0].endedAt).toBeGreaterThanOrEqual(s.receipt.result.validationReports[0].startedAt);
  });
});
