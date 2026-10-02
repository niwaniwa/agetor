import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// Verifies the headless contract of the DI refactor: with NO `native` injected
// (the way the cli-daemon starts the server), non-native routes work but every
// native-host route returns 501 instead of crashing on a missing Electrobun.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-headless-"));
process.env.AGETOR_DATA_DIR = DATA_DIR;
process.env.AGETOR_API_PORT = "4467";
const PORT = 4467;

let server: { stop: () => void };
let token: string;

beforeAll(async () => {
  await import("./db.ts");
  const { startApiServer, API_TOKEN } = await import("./server.ts");
  server = startApiServer() as unknown as { stop: () => void }; // headless: no native
  token = API_TOKEN;
});

afterAll(() => server?.stop?.());

const auth = () => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const u = (p: string) => `http://127.0.0.1:${PORT}${p}`;

test("non-native routes work headless (/info, /tasks)", async () => {
  expect((await fetch(u("/info"), { headers: auth() })).status).toBe(200);
  expect((await fetch(u("/tasks"), { headers: auth() })).status).toBe(200);
});

test("every native-host route returns 501 when running headless", async () => {
  const cases: Array<[string, RequestInit]> = [
    ["/notifications", { method: "POST", headers: auth(), body: JSON.stringify({ title: "x" }) }],
    ["/open-external", { method: "POST", headers: auth(), body: JSON.stringify({ url: "https://example.com" }) }],
    ["/open-path", { method: "POST", headers: auth(), body: JSON.stringify({ path: "/tmp" }) }],
    ["/projects/pick", { method: "POST", headers: auth(), body: "{}" }],
    ["/refs/pick", { method: "POST", headers: auth(), body: "{}" }],
    ["/updates/status", { method: "GET", headers: auth() }],
    ["/updates/check", { method: "POST", headers: auth() }],
    ["/updates/apply", { method: "POST", headers: auth() }],
    ["/window/focus", { method: "POST", headers: auth() }],
  ];
  for (const [p, init] of cases) {
    const res = await fetch(u(p), init);
    expect({ route: p, status: res.status }).toEqual({ route: p, status: 501 });
  }
});

test("native routes still enforce the token (401 without it)", async () => {
  const res = await fetch(u("/notifications"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  expect(res.status).toBe(401);
});

test("headless tmux attach returns a runnable command for the dedicated socket", async () => {
  const { tasks, db } = await import("./db.ts");
  const { sessionNameFor } = await import("./claude-tmux.ts");
  const taskId = randomUUID();
  tasks.insert({
    id: taskId, title: "headless attach fixture", prompt: "unused", agent: "claude-code",
    workdir: DATA_DIR, isolation: "none", taskType: "task", branch: null,
    branchSource: "created", worktreePath: null, baseRef: null, prUrl: null,
    mode: null, model: null, effort: null, fast: false, maxMode: false,
    references: [], backlog: [], plans: [], draft: null, column: "ready", runId: null,
    createdAt: Date.now(), updatedAt: Date.now(), hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, archivedAt: null,
  });
  // An inert executable verifies both argv and shell quoting; no tmux server
  // or native terminal application is opened during this test.
  const fakeTmux = path.join(DATA_DIR, "fake tmux's binary");
  const calls = path.join(DATA_DIR, "tmux-calls");
  const quotedCalls = `'${calls.replace(/'/g, `'\\''`)}'`;
  writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quotedCalls}\nexit 0\n`);
  chmodSync(fakeTmux, 0o700);
  const oldBin = process.env.AGETOR_TMUX_BIN;
  const oldSocket = process.env.AGETOR_TMUX_SOCKET;
  process.env.AGETOR_TMUX_BIN = fakeTmux;
  process.env.AGETOR_TMUX_SOCKET = "kaname-headless-fixture";
  try {
    const response = await fetch(u(`/tasks/${taskId}/open-tmux`), { method: "POST", headers: auth() });
    expect(response.status).toBe(200);
    const result = await response.json() as { ok: boolean; sessionName: string; command: string };
    expect(result.ok).toBe(true);
    expect(result.sessionName).toBe(sessionNameFor(taskId));
    expect(typeof result.command).toBe("string");
    const expectedPrefix = ["-L", "kaname-headless-fixture"];
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      ...expectedPrefix, "has-session", "-t", "=" + result.sessionName,
    ]);
    writeFileSync(calls, "");
    const proc = Bun.spawn(["sh", "-c", result.command], { stdout: "ignore", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      ...expectedPrefix, "attach", "-t", result.sessionName,
    ]);
  } finally {
    if (oldBin === undefined) delete process.env.AGETOR_TMUX_BIN; else process.env.AGETOR_TMUX_BIN = oldBin;
    if (oldSocket === undefined) delete process.env.AGETOR_TMUX_SOCKET; else process.env.AGETOR_TMUX_SOCKET = oldSocket;
    db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
  }
});

test("headless project registration rejects a regular file", async () => {
  const file = path.join(DATA_DIR, "not-a-project.txt");
  writeFileSync(file, "fixture");
  const response = await fetch(u("/projects"), {
    method: "POST", headers: auth(), body: JSON.stringify({ path: file }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "path must be a directory" });
  const { projects } = await import("./db.ts");
  expect(projects.list().some(project => project.path === file)).toBe(false);
});
