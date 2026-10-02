// Linux integration smoke: real HTTP, SQLite, detached tmux, mocked CLI output.
// No provider requests, notifications, or Git/GitHub writes. Run after build:web.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

const scratch = mkdtempSync(path.join(tmpdir(), "kaname-smoke-"));
const dataDir = path.join(scratch, "data");
const workdir = path.join(scratch, "task");
mkdirSync(workdir);
const reservePort = () => { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port!; s.stop(true); return p; };
const apiPort = reservePort();
const webPort = reservePort();
const base = `http://127.0.0.1:${webPort}`;
const tmuxSocket = `kaname-smoke-${process.pid}`;
const counter = path.join(scratch, "spawns.txt");
const codex = path.join(scratch, "mock-codex");
writeFileSync(codex, `#!/usr/bin/env python3
import sys, json, time
if '--version' in sys.argv:
    print('codex-cli 0.159.0')
    sys.exit(0)
prompt = sys.stdin.read()
with open(${JSON.stringify(counter)}, 'a') as f: f.write('spawn\\n')
def emit(value): print(json.dumps(value), flush=True)
emit({'type':'thread.started','thread_id':'mock-thread'})
emit({'type':'item.completed','item':{'id':'item_0','type':'agent_message','text':'mock running'}})
time.sleep(3 if 'OFFLINE' in prompt else 30)
emit({'type':'item.completed','item':{'id':'item_1','type':'agent_message','text':'mock finished'}})
emit({'type':'turn.completed'})
`, { mode: 0o700 });
let service: ReturnType<typeof Bun.spawn> | undefined;
let generation = 0;
let cookie = "";
const env = {
  ...process.env, AGETOR_DATA_DIR: dataDir, AGETOR_API_PORT: String(apiPort), KANAME_WEB_PORT: String(webPort),
  AGETOR_TMUX_SOCKET: tmuxSocket, AGETOR_BACKGROUND_DISCOVERY: "0", AGETOR_TRACK_SUBAGENTS: "0",
  AGETOR_CODEX_BIN: codex, AGETOR_CODEX_DRIVER: "tmux", AGETOR_CLAUDE_DRIVER: "fake", AGETOR_CLAUDE_BIN: "/bin/echo",
  AGETOR_SKIP_CLI_VERSION_FLOOR: "1", AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS: "1000",
};
async function waitFor<T>(fn: () => Promise<T>, accept: (value: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (accept(value)) return value;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting for expected state");
}
async function boot() {
  const log = path.join(scratch, `service-${++generation}.log`);
  service = Bun.spawn([process.execPath, "src/bun/kaname.ts"], { cwd: path.resolve(import.meta.dir, ".."), env, stdout: Bun.file(log), stderr: Bun.file(log) });
  await waitFor(() => fetch(base + "/auth/session").then(r => r.ok).catch(() => false), Boolean);
}
async function stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  if (!service) return;
  service.kill(signal); await service.exited; service = undefined;
  // The lock guardian observes EOF after the service's fd closes.
  await Bun.sleep(150);
}
async function request(route: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(base + route, { method, headers: {
    origin: base, cookie, "content-type": "application/json",
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(res.ok, true, `${route}: ${res.status} ${await res.clone().text()}`);
  return res.status === 204 ? null : res.json();
}
async function create(agent: string, prompt: string) {
  const task = await request("/api/tasks", "POST", { title: prompt, prompt, agent, workdir, isolation: "none", mode: "ask" });
  assert.equal(task.column, "backlog");
  assert.equal((await request(`/api/tasks/${task.id}/runs`)).length, 0);
  const started = await request(`/api/tasks/${task.id}/start`, "POST");
  return { taskId: task.id, runId: started.runId };
}
async function getRun(taskId: string, runId: string) {
  return (await request(`/api/tasks/${taskId}/runs`)).find((r: any) => r.id === runId);
}
async function replay(taskId: string) {
  const controller = new AbortController();
  const res = await fetch(base + `/api/tasks/${taskId}/events`, { headers: { cookie }, signal: controller.signal });
  const reader = res.body!.getReader();
  const result = await reader.read();
  controller.abort(); await reader.cancel().catch(() => {});
  return new TextDecoder().decode(result.value);
}
try {
  await boot();
  // Seed mock harness visibility directly; Settings' enable route deliberately
  // probes the provider catalog, which is outside this offline fixture.
  const fixtureDb = new Database(path.join(dataDir, "agetor.sqlite"));
  fixtureDb.run("UPDATE harnesses SET enabled = 1 WHERE id = 'codex'");
  fixtureDb.close();
  assert.equal((await fetch(base + "/api/tasks")).status, 401);
  const login = await fetch(base + "/auth/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ token: readFileSync(path.join(dataDir, "web-login-token"), "utf8").trim() }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const claude = await create("claude-code", "Mock Claude completion");
  await waitFor(() => getRun(claude.taskId, claude.runId), r => r.status === "succeeded");
  assert.match(await replay(claude.taskId), /data:/);
  const stoppedClaude = await create("claude-code", "Mock Claude stop");
  assert.equal((await request(`/api/runs/${stoppedClaude.runId}/cancel`, "POST")).cancelled, true);
  assert.equal((await getRun(stoppedClaude.taskId, stoppedClaude.runId)).status, "cancelled");

  const live = await create("codex", "LIVE restart recovery");
  await waitFor(() => getRun(live.taskId, live.runId), r => r.codexSessionId === "mock-thread");
  const before = await replay(live.taskId);
  assert.match(before, /mock running/);
  await stop("SIGKILL");
  await boot();
  assert.equal((await request("/auth/session")).authenticated, true);
  assert.equal((await getRun(live.taskId, live.runId)).status, "running");
  assert.equal((await request(`/api/tasks/${live.taskId}/runs`)).length, 1);
  assert.match(await replay(live.taskId), /mock running/);
  assert.equal((await request(`/api/runs/${live.runId}/cancel`, "POST")).cancelled, true);
  await waitFor(() => getRun(live.taskId, live.runId), r => r.status === "cancelled");

  const offline = await create("codex", "OFFLINE completion recovery");
  await waitFor(() => getRun(offline.taskId, offline.runId), r => r.codexSessionId === "mock-thread");
  await stop();
  await Bun.sleep(4000);
  await boot();
  await waitFor(() => getRun(offline.taskId, offline.runId), r => r.status === "succeeded");
  assert.match(await replay(offline.taskId), /mock finished/);
  assert.equal((await request(`/api/tasks/${offline.taskId}/runs`)).length, 1);
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2, "no duplicate CLI launches");
  assert.equal((await getRun(stoppedClaude.taskId, stoppedClaude.runId)).status, "cancelled");
  console.log(JSON.stringify({ ok: true, scratch, checks: ["login", "backlog does not launch", "Claude mock complete/stop", "SSE replay", "SIGKILL restart during tmux run", "cookie persistence", "stop after reattach", "offline completion", "no duplicate launch"] }, null, 2));
} finally {
  await stop();
  // Unique socket created only by this script; never touch the user's tmux server.
  await Bun.spawn(["tmux", "-L", tmuxSocket, "kill-server"], { stdout: "ignore", stderr: "ignore" }).exited;
}
