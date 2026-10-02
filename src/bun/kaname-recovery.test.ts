import { afterAll, afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunStatus } from "../shared/types.ts";

// No CLI, git operation, or actual tmux server is used in these restart tests.
const mockEnvKeys = ["AGETOR_DATA_DIR", "AGETOR_CODEX_DRIVER", "AGETOR_CODEX_BIN", "AGETOR_CLAUDE_DRIVER", "AGETOR_CLAUDE_BIN", "AGETOR_TMUX_BIN"];
const previousEnv = Object.fromEntries(mockEnvKeys.map((key) => [key, process.env[key]]));
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "kaname-recovery-"));
process.env.AGETOR_CODEX_DRIVER = "fake";
process.env.AGETOR_CODEX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/false";
const { createTask, reconcileOrphans, cancelRun } = await import("./orchestrator.ts");
const { db, runs, tasks, harnesses } = await import("./db.ts");
const { codexLogPath, dropCodexSession } = await import("./codex-tmux.ts");
const { sessionNameFor, jsonlPathFor, dropSession } = await import("./claude-tmux.ts");
const createdIds: string[] = [];
harnesses.setEnabled("codex", true);
const claudeHome = mkdtempSync(path.join(tmpdir(), "kaname-claude-recovery-"));
harnesses.insert({ id: "claude-recovery", kind: "claude-code", label: "Mock Claude recovery", home: claudeHome, bin: "/bin/echo" });
harnesses.setEnabled("claude-recovery", true);

afterAll(() => {
  harnesses.delete("claude-recovery");
  for (const key of mockEnvKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function runningTask(agent = "codex") {
  const created = await createTask({
    title: "mock restart recovery", prompt: "local fixture", agent,
    workdir: tmpdir(), isolation: "none", taskType: "task",
  });
  if ("error" in created) throw new Error(created.error);
  const taskId = created.task.id;
  createdIds.push(taskId);
  const runId = insertRun(taskId, agent);
  tasks.update(taskId, { column: "running", runId });
  return { taskId, runId };
}

function insertRun(taskId: string, agent = "codex", startedAt = Date.now()) {
  const id = crypto.randomUUID();
  runs.insert({
    id, taskId, agent, status: "running", startedAt, endedAt: null, exitCode: null,
    tmuxSession: sessionNameFor(taskId), claudeSessionId: agent.startsWith("claude") ? crypto.randomUUID() : null,
    codexSessionId: null, cursorSessionId: null, geminiSessionId: null, fxSessionId: null,
  });
  return id;
}

function log(runId: string, events: unknown[]) {
  mkdirSync(path.dirname(codexLogPath(runId)), { recursive: true });
  writeFileSync(codexLogPath(runId), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

function message(text: string, id = "item_0") {
  return { type: "item.completed", item: { id, type: "agent_message", text } };
}

async function settle(runId: string, status: RunStatus) {
  for (let i = 0; i < 100 && runs.get(runId)?.status !== status; i++) await Bun.sleep(20);
  expect(runs.get(runId)?.status).toBe(status);
}

afterEach(async () => {
  for (const id of createdIds.splice(0)) {
    await dropCodexSession(id);
    await dropSession(id);
    db.run("DELETE FROM tasks WHERE id = ?", [id]);
  }
  process.env.AGETOR_TMUX_BIN = "/bin/false";
});

test("recovers Codex completion and session id recorded while service was offline", async () => {
  const { taskId, runId } = await runningTask();
  log(runId, [{ type: "thread.started", thread_id: "offline-thread" }, message("offline result"), { type: "turn.completed" }]);
  expect(await reconcileOrphans()).toBe(0);
  await settle(runId, "succeeded");
  expect(tasks.get(taskId)?.column).toBe("review");
  expect(runs.get(runId)?.codexSessionId).toBe("offline-thread");
  expect(runs.events(runId).filter((event) => event.stream === "assistant").map((event) => event.data)).toEqual(["offline result"]);
  expect(await reconcileOrphans()).toBe(0);
  expect(runs.listForTask(taskId)).toHaveLength(1);
});

test("recovers Codex failure without calling it successful or starting a retry", async () => {
  const { taskId, runId } = await runningTask();
  log(runId, [{ type: "turn.failed", error: { message: "mock failure while offline" } }]);
  expect(await reconcileOrphans()).toBe(0);
  await settle(runId, "failed");
  expect(runs.events(runId).some((event) => event.data.includes("mock failure while offline"))).toBe(true);
  expect(runs.listForTask(taskId)).toHaveLength(1);
});

test("reattaches live Codex before its thread id was persisted and deduplicates replay", async () => {
  process.env.AGETOR_TMUX_BIN = "/bin/true";
  const { taskId, runId } = await runningTask();
  runs.appendEvent(runId, "assistant", "before restart", "item.completed:item_0");
  log(runId, [{ type: "thread.started", thread_id: "late-thread" }, message("before restart"), message("after restart", "item_1")]);
  expect(await reconcileOrphans()).toBe(0);
  expect(tasks.get(taskId)?.column).toBe("running");
  appendFileSync(codexLogPath(runId), JSON.stringify({ type: "turn.completed" }) + "\n");
  await settle(runId, "succeeded");
  expect(runs.get(runId)?.codexSessionId).toBe("late-thread");
  expect(runs.events(runId).filter((event) => event.stream === "assistant").map((event) => event.data)).toEqual(["before restart", "after restart"]);
});

test("Codex item ids reused across turns do not erase recovered follow-up output", async () => {
  const { taskId, runId } = await runningTask();
  const previousId = insertRun(taskId, "codex", Date.now() - 1000);
  runs.update(previousId, { status: "succeeded", endedAt: Date.now() - 500, exitCode: 0 });
  runs.appendEvent(previousId, "assistant", "previous turn", "item.completed:item_0");
  log(runId, [message("current turn"), { type: "turn.completed" }]);
  expect(await reconcileOrphans()).toBe(0);
  await settle(runId, "succeeded");
  expect(runs.events(runId).some((event) => event.data === "current turn")).toBe(true);
});

test("orphaning an older running row preserves the reattached current task", async () => {
  process.env.AGETOR_TMUX_BIN = "/bin/true";
  const { taskId, runId } = await runningTask();
  const oldId = insertRun(taskId, "codex", Date.now() - 1000);
  log(runId, [message("still running")]);
  expect(await reconcileOrphans()).toBe(1);
  expect(runs.get(oldId)?.status).toBe("orphaned");
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(tasks.get(taskId)?.runId).toBe(runId);
  appendFileSync(codexLogPath(runId), JSON.stringify({ type: "turn.completed" }) + "\n");
  await settle(runId, "succeeded");
});

test("dead Codex with incomplete log is orphaned and retains diagnostic output", async () => {
  const { taskId, runId } = await runningTask();
  log(runId, [message("partial result")]);
  expect(await reconcileOrphans()).toBe(1);
  expect(runs.get(runId)?.status).toBe("orphaned");
  expect(tasks.get(taskId)?.column).toBe("ready");
  expect(tasks.get(taskId)?.runId).toBeNull();
  expect(runs.events(runId).some((event) => event.data === "partial result")).toBe(true);
  expect(runs.listForTask(taskId)).toHaveLength(1);
});

test("dead Claude session recovers to Ready without automatically starting a CLI", async () => {
  const { taskId, runId } = await runningTask("claude-code");
  expect(await reconcileOrphans()).toBe(1);
  expect(runs.get(runId)?.status).toBe("orphaned");
  expect(tasks.get(taskId)?.column).toBe("ready");
  expect(runs.listForTask(taskId)).toHaveLength(1);
});

test("live Claude replay preserves old output and captures the completed offline turn", async () => {
  process.env.AGETOR_TMUX_BIN = "/bin/true";
  const { taskId, runId } = await runningTask("claude-recovery");
  const jsonlPath = jsonlPathFor(tmpdir(), runs.get(runId)!.claudeSessionId!, claudeHome);
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  runs.appendEvent(runId, "assistant", "before restart", "claude-old");
  writeFileSync(jsonlPath, [
    { type: "assistant", uuid: "claude-old", message: { role: "assistant", content: [{ type: "text", text: "before restart" }], stop_reason: null } },
    { type: "assistant", uuid: "claude-new", message: { role: "assistant", content: [{ type: "text", text: "offline completion" }], stop_reason: "end_turn" } },
    { type: "system", uuid: "claude-metadata", permissionMode: "default" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  expect(await reconcileOrphans()).toBe(0);
  await settle(runId, "succeeded");
  expect(tasks.get(taskId)?.column).toBe("review");
  expect(runs.events(runId).filter((event) => event.stream === "assistant").map((event) => event.data)).toEqual(["before restart", "offline completion"]);
  expect(runs.listForTask(taskId)).toHaveLength(1);
});

test("a reattached Claude turn can still be stopped through the orchestrator", async () => {
  process.env.AGETOR_TMUX_BIN = "/bin/true";
  const { taskId, runId } = await runningTask("claude-recovery");
  const jsonlPath = jsonlPathFor(tmpdir(), runs.get(runId)!.claudeSessionId!, claudeHome);
  mkdirSync(path.dirname(jsonlPath), { recursive: true });
  writeFileSync(jsonlPath, "");
  expect(await reconcileOrphans()).toBe(0);
  expect(tasks.get(taskId)?.column).toBe("running");
  expect(await cancelRun(runId)).toBe(true);
  await settle(runId, "cancelled");
  expect(runs.listForTask(taskId)).toHaveLength(1);
});
