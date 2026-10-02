// Opt-in real CLI smoke; never discovered by bun test. Uses an empty temporary
// directory, existing CLI login, read-only task instructions and no Git writes.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.argv.includes("--real")) throw new Error("Real provider use requires explicit --real");
const agent = process.argv.includes("--claude") ? "claude-code" : "codex";
const scratch = mkdtempSync(path.join(tmpdir(), "kaname-cli-"));
const dataDir = path.join(scratch, "data");
const workdir = path.join(scratch, "task");
mkdirSync(workdir);
writeFileSync(path.join(workdir, "numbers.txt"), "4\n7\n9\n");
const port = () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port!; server.stop(true); return port; };
const apiPort = port(); const webPort = port();
const origin = `http://127.0.0.1:${webPort}`;
const socket = `kaname-cli-${process.pid}`;
let service: ReturnType<typeof Bun.spawn> | undefined;
let cookie = "";
let generation = 0;
const ids: string[] = [];
const env = { ...process.env, AGETOR_DATA_DIR: dataDir, AGETOR_API_PORT: String(apiPort), KANAME_WEB_PORT: String(webPort), AGETOR_TMUX_SOCKET: socket, AGETOR_BACKGROUND_DISCOVERY: "0", AGETOR_TRACK_SUBAGENTS: "0", AGETOR_CODEX_DRIVER: "tmux", AGETOR_CLAUDE_DRIVER: "tmux" };
if (agent === "claude-code") {
  // Smoke-only constraints: keep OAuth, disable customizations/integrations,
  // expose only reading and Bash, and pre-allow only sleep commands in Bash.
  // Other shell commands retain the CLI's normal ask-mode approval checks.
  Object.assign(env, { AGETOR_CLAUDE_ARGS: "--safe-mode --no-chrome --tools Read,Bash --allowedTools Read,Bash(sleep:*)" });
}
async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (matches(result)) return result; await Bun.sleep(200); }
  throw new Error(`Timed out after ${timeout}ms; inspect ${scratch}`);
}
async function boot() {
  const logfile = path.join(scratch, `service-${++generation}.log`);
  service = Bun.spawn([process.execPath, "src/bun/kaname.ts"], { cwd: path.resolve(import.meta.dir, ".."), env, stdout: Bun.file(logfile), stderr: Bun.file(logfile) });
  await waitFor(() => fetch(origin + "/auth/session").then(r => r.ok).catch(() => false), Boolean);
}
async function stop() {
  if (!service) return;
  service.kill("SIGTERM"); await service.exited; service = undefined; await Bun.sleep(150);
}
async function api(route: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(origin + route, { method, headers: { origin, cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.ok, true, `${route}: ${JSON.stringify(result)}`);
  return result;
}
async function create(waitSeconds: number) {
  const task = await api("/api/tasks", "POST", {
    title: `${agent} local smoke ${waitSeconds}s`, agent, workdir, isolation: "none", mode: "ask",
    prompt: `This is a tiny local KANAME smoke test in a temporary non-Git directory. First use Bash to run exactly sleep ${waitSeconds}, then read numbers.txt in the current directory${agent === "claude-code" ? " using the Read tool" : ""} and report its sum followed by KANAME_SMOKE_OK. Do not modify files, use Git, GitHub, notifications, plugins, network commands, or delegate to other agents. Only sleep and reading this local file are permitted.`,
  });
  const started = await api(`/api/tasks/${task.id}/start`, "POST");
  ids.push(started.runId);
  return { taskId: task.id, runId: started.runId };
}
async function run(taskId: string, runId: string) { return (await api(`/api/tasks/${taskId}/runs`)).find((run: any) => run.id === runId); }
function hasToolEvent(runId: string) {
  const db = new Database(path.join(dataDir, "agetor.sqlite"), { readonly: true });
  try { return Boolean(db.query("SELECT 1 FROM run_events WHERE run_id = ? AND stream = 'tool_use' LIMIT 1").get(runId)); }
  finally { db.close(); }
}
try {
  console.log(JSON.stringify({ agent, scratch, stage: "boot" }));
  await boot();
  const fixture = new Database(path.join(dataDir, "agetor.sqlite"));
  fixture.run("UPDATE harnesses SET enabled = 1 WHERE id = ?", [agent]); fixture.close();
  const login = await fetch(origin + "/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: readFileSync(path.join(dataDir, "web-login-token"), "utf8").trim() }) });
  assert.equal(login.status, 200); cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const task = await create(8);
  console.log(JSON.stringify({ stage: "started", ...task }));
  if (agent === "claude-code" && process.argv.includes("--login-check")) {
    const observed = await waitFor(async () => {
      const current = await run(task.taskId, task.runId);
      if (!current.tmuxSession) return false;
      const pane = Bun.spawn(["tmux", "-L", socket, "capture-pane", "-p", "-t", current.tmuxSession], { stdout: "pipe", stderr: "ignore" });
      const text = await new Response(pane.stdout).text();
      return await pane.exited === 0 && /log\s*in|sign\s*in|account|Welcome to Claude/i.test(text);
    }, Boolean, 45_000);
    assert.equal(observed, true);
    assert.equal((await api(`/api/runs/${task.runId}/cancel`, "POST")).cancelled, true);
    await waitFor(() => run(task.taskId, task.runId), value => value.status === "cancelled");
    console.log(JSON.stringify({ ok: true, agent, scratch, checks: ["real CLI TUI launch", "login/onboarding screen observed", "stop"], limitation: "No authenticated task completion verified" }, null, 2));
    // finally still cancels any remaining run and destroys only this fixture's socket.
  } else {
  const launched = await waitFor(() => run(task.taskId, task.runId), value => value.status !== "running" || (agent === "claude-code" ? hasToolEvent(task.runId) : Boolean(value.codexSessionId)), 45_000);
  if (launched.status !== "running") throw new Error(`CLI exited before restart: ${launched.status}`);
  await stop(); await boot();
  assert.equal((await api("/auth/session")).authenticated, true);
  assert.equal((await api(`/api/tasks/${task.taskId}/runs`)).length, 1);
  const completed = await waitFor(() => run(task.taskId, task.runId), value => value.status !== "running", 120_000);
  assert.equal(completed.status, "succeeded");
  const db = new Database(path.join(dataDir, "agetor.sqlite"));
  const output = db.query<{ data: string }, [string]>("SELECT data FROM run_events WHERE run_id = ? AND stream = 'assistant'").all(task.runId).map(row => row.data).join("\n");
  db.close();
  assert.match(output, /20/); assert.match(output, /KANAME_SMOKE_OK/);
  const cancelled = await create(60);
  await waitFor(() => run(cancelled.taskId, cancelled.runId), value => agent === "claude-code" ? hasToolEvent(cancelled.runId) : Boolean(value.codexSessionId));
  assert.equal((await api(`/api/runs/${cancelled.runId}/cancel`, "POST")).cancelled, true);
  await waitFor(() => run(cancelled.taskId, cancelled.runId), value => value.status === "cancelled");
  console.log(JSON.stringify({ ok: true, agent, scratch, checks: ["real CLI launch", "same run after service restart", "local file read result 20", "persisted assistant log", "stop"] }, null, 2));
  }
} finally {
  if (service) for (const id of ids) await api(`/api/runs/${id}/cancel`, "POST").catch(() => {});
  await stop();
  await Bun.spawn(["tmux", "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" }).exited;
}
