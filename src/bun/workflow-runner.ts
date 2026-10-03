import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowLaunchManifest, WorkflowRunner, WorkflowRunnerObservation } from "../shared/development-workflow.ts";
import { assertWorkflowAttemptId, parseWorkflowAgentResult, parseWorkflowValidationReports, workflowCalendarDeadline, workflowUnitNames } from "./workflow-runner-protocol.ts";
import { writeWorkflowReceipt } from "./workflow-worker.ts";

export interface WorkflowCommandResult { code: number; stdout: string; stderr: string }
export interface SystemdWorkflowRunnerOptions {
  artifactRoot: string;
  command?: (argv: string[]) => Promise<WorkflowCommandResult>;
  now?: () => number;
  /** Injectable only for tests. null = cannot establish whether the scope is empty. */
  cgroupEmpty?: (controlGroup: string) => boolean | null;
  bunPath?: string;
  workerPath?: string;
  /** Service environment is explicit because user systemd may have a different PATH. */
  environment?: Record<string, string>;
}

interface UnitState { loaded: boolean; active: string; sub: string; controlGroup: string | null; result: string }
interface StartedReceipt { startedAt: number; controlGroup: string | null }
interface ExitReceipt { endedAt: number; controlGroup: string | null; serviceResult?: string; neverStarted?: boolean }

async function defaultCommand(argv: string[]): Promise<WorkflowCommandResult> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timeout); }
}

/** cgroup v2's populated flag includes all descendants, not only MainPID. */
export function workflowCgroupEmpty(controlGroup: string): boolean | null {
  if (!controlGroup.startsWith("/") || controlGroup === "/" || controlGroup.split("/").includes("..")) return null;
  try {
    const events = readFileSync(join("/sys/fs/cgroup", controlGroup, "cgroup.events"), "utf8");
    return /^populated 0$/m.test(events) ? true : /^populated 1$/m.test(events) ? false : null;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? true : null; }
}

/** systemd Exec*= syntax, deliberately not shell escaping. ':' disables $ expansion. */
export function workflowSystemdExec(argv: string[]): string {
  return ":" + argv.map(arg => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`).join(" ");
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function logTail(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size, length = Math.min(size, 128 * 1024), bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, size - length); return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

export function createSystemdWorkflowRunner(options: SystemdWorkflowRunnerOptions): WorkflowRunner {
  const root = resolve(options.artifactRoot);
  const command = options.command ?? defaultCommand, now = options.now ?? Date.now;
  const cgroupEmpty = options.cgroupEmpty ?? workflowCgroupEmpty;
  const workerPath = options.workerPath ?? fileURLToPath(new URL("./workflow-worker.ts", import.meta.url));
  const bunPath = options.bunPath ?? process.execPath;
  const locks = new Map<string, Promise<unknown>>();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new Error("Workflow artifact root must not be a symlink");
  function directory(id: string): string {
    assertWorkflowAttemptId(id);
    const dir = join(root, id);
    if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error("Unsafe attempt artifact directory");
    return dir;
  }
  async function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action); locks.set(id, next);
    try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
  }
  async function unit(name: string): Promise<UnitState> {
    const r = await command(["systemctl", "--user", "show", name, "--no-pager", "--property=LoadState,ActiveState,SubState,ControlGroup,Result"]);
    const p = Object.fromEntries(r.stdout.split("\n").filter(l => l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
    if (p.LoadState === "not-found" && (r.code === 0 || r.code === 1 || r.code === 4)) return { loaded: false, active: "inactive", sub: "dead", controlGroup: null, result: "not-found" };
    if (r.code !== 0 || p.LoadState !== "loaded" || !p.ActiveState) throw new Error(`Cannot inspect systemd unit ${name}: ${r.stderr || r.stdout || r.code}`);
    return { loaded: true, active: p.ActiveState, sub: p.SubState ?? "", controlGroup: p.ControlGroup || null, result: p.Result ?? "" };
  }
  async function checked(argv: string[]): Promise<void> {
    const result = await command(argv);
    if (result.code !== 0) throw new Error(`Workflow supervisor command failed: ${result.stderr || result.stdout || result.code}`);
  }
  function manifestFor(id: string): WorkflowLaunchManifest | undefined { return readJson(join(directory(id), "manifest.json")); }
  function writeNeverStarted(dir: string): void {
    writeWorkflowReceipt(join(dir, "unit-exit.json"), { endedAt: now(), controlGroup: null, serviceResult: "cancelled-before-start", neverStarted: true });
    writeWorkflowReceipt(join(dir, "result.json"), { result: { status: "failed", summary: "Attempt cancelled before launch." }, completedAt: now(), exitCode: 124 });
  }

  return {
    async start(manifest) {
      await serialized(manifest.attemptId, async () => {
        const dir = directory(manifest.attemptId), names = workflowUnitNames(manifest.attemptId);
        if (resolve(manifest.artifactDir) !== dir || !isAbsolute(manifest.cwd) || !Number.isFinite(manifest.stopAt)
          || !Number.isFinite(manifest.deadlineAt) || manifest.deadlineAt <= manifest.stopAt || manifest.deadlineAt - manifest.stopAt > 60_000) throw new Error("Invalid workflow artifact path or deadline");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (dirname(realpathSync(dir)) !== realpathSync(root)) throw new Error("Workflow artifact directory escaped its root");
        const manifestPath = join(dir, "manifest.json");
        const previous = readJson<WorkflowLaunchManifest>(manifestPath);
        if (previous && JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error("Attempt ID already belongs to a different immutable manifest");
        if (!previous) writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
        // Never rerun an attempt whose worker has executed, even if its unit was garbage collected.
        if (existsSync(join(dir, "started.json")) || existsSync(join(dir, "unit-exit.json")) || existsSync(join(dir, "stop-request.json"))) return;
        const state = await unit(names.service);
        if (state.loaded) return;
        if (now() >= manifest.stopAt) {
          writeWorkflowReceipt(join(dir, "stop-request.json"), { at: now(), reason: "expired-before-start" }); writeNeverStarted(dir); return;
        }
        const timer = await unit(names.timer);
        if (!timer.loaded) {
          await checked(["systemd-run", "--user", "--quiet", "--no-ask-password", `--unit=${names.stopper}`,
            `--on-calendar=${workflowCalendarDeadline(manifest.stopAt)}`, "--timer-property=AccuracySec=1ms", "--timer-property=RandomizedDelaySec=0",
            "--property=Type=oneshot", "--property=Restart=no", "--expand-environment=no",
            "--", "/usr/bin/systemctl", "--user", "stop", names.service]);
        }
        const armed = await unit(names.timer);
        if (!armed.loaded || armed.active !== "active") throw new Error("Absolute workflow deadline timer is not armed; refusing CLI launch");
        if (now() >= manifest.stopAt || existsSync(join(dir, "stop-request.json"))) {
          writeWorkflowReceipt(join(dir, "stop-request.json"), { at: now(), reason: "expired-before-start" }); writeNeverStarted(dir); return;
        }
        const environment: Record<string, string> = {
          PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "",
          ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
          ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
          ...options.environment,
        };
        const args = ["systemd-run", "--user", "--quiet", "--no-ask-password", `--unit=${names.service}`,
          "--property=Type=exec", "--property=Restart=no", "--property=KillMode=control-group", "--property=SendSIGKILL=yes",
          `--property=TimeoutStopSec=${(manifest.deadlineAt - manifest.stopAt) / 1000}s`,
          `--property=RuntimeMaxSec=${Math.max(0.001, (manifest.stopAt - now()) / 1000)}s`,
          `--property=ExecStopPost=${workflowSystemdExec([bunPath, workerPath, "--record-stop", manifestPath])}`,
          `--working-directory=${manifest.cwd}`, "--expand-environment=no",
          ...Object.entries(environment).map(([k, v]) => `--setenv=${k}=${v}`), "--", bunPath, workerPath, manifestPath];
        await checked(args);
      });
    },
    async inspect(attemptId): Promise<WorkflowRunnerObservation> {
      try {
        const dir = directory(attemptId);
        const started = readJson<StartedReceipt>(join(dir, "started.json"));
        const ended = readJson<ExitReceipt>(join(dir, "unit-exit.json"));
        if (!manifestFor(attemptId) && !(ended?.neverStarted === true && existsSync(join(dir, "stop-request.json")))) return { status: "unknown", error: "No durable launch manifest; execution absence is not yet proven." };
        const state = await unit(workflowUnitNames(attemptId).service);
        const common = { startedAt: started?.startedAt, logs: logTail(join(dir, "events.jsonl")) };
        if (state.loaded && !["inactive", "failed"].includes(state.active)) return { ...common, status: "running" };
        const group = state.controlGroup ?? ended?.controlGroup ?? started?.controlGroup;
        const empty = group ? cgroupEmpty(group) : ended?.neverStarted === true;
        if (empty !== true) return { ...common, status: "unknown", error: empty === false ? "The attempt cgroup still contains processes." : "Attempt scope exit is not proven." };
        let result;
        try {
          const raw = readJson<{ result: unknown }>(join(dir, "result.json"));
          result = raw ? parseWorkflowAgentResult(raw.result) : { status: "failed" as const, summary: `Attempt exited without a final result (${ended?.serviceResult ?? state.result}).` };
        } catch (error) {
          // A malformed result is a failed attempt, not an uncertain live process.
          result = { status: "failed" as const, summary: `Invalid terminal result: ${String(error)}` };
        }
        try {
          const reports = readJson<unknown>(join(dir, "validation.json"));
          if (reports !== undefined) result.validationReports = parseWorkflowValidationReports(reports);
        } catch (error) { result = { status: "failed" as const, summary: `Invalid worker validation report: ${String(error)}`, validationPassed: false }; }
        // Only a cancellation tombstone plus authoritative unit/cgroup absence
        // proves zero execution. Do not charge daemon downtime for that case.
        // Missing timestamps on an actually started scope remain conservative.
        const endedAt = ended?.endedAt ?? now();
        const startedAt = started?.startedAt ?? (ended?.neverStarted === true ? endedAt : undefined);
        return { ...common, startedAt, status: "stopped", endedAt, result };
      } catch (error) { return { status: "unknown", error: String(error) }; }
    },
    async stop(attemptId) {
      await serialized(attemptId, async () => {
        const dir = directory(attemptId);
        // A reservation may be cancelled after a crash before manifest creation.
        // Persist cancellation first so a delayed start can never launch its CLI.
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeWorkflowReceipt(join(dir, "stop-request.json"), { at: now(), reason: "explicit-stop" });
        const names = workflowUnitNames(attemptId), before = await unit(names.service);
        if (before.loaded) await checked(["systemctl", "--user", "stop", names.service]);
        const after = await unit(names.service);
        if (after.loaded && !["inactive", "failed"].includes(after.active)) throw new Error("Workflow service is still stopping");
        if (before.controlGroup && cgroupEmpty(before.controlGroup) !== true) throw new Error("Workflow cgroup exit is not yet proven");
        if (!readJson(join(dir, "started.json")) && !readJson(join(dir, "unit-exit.json")) && !after.controlGroup) writeNeverStarted(dir);
        // Stopping the timer is cleanup only; an already queued stopper merely repeats the stop.
        const timer = await unit(names.timer);
        if (timer.loaded) await checked(["systemctl", "--user", "stop", names.timer]);
      });
    },
  };
}
