import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// db.ts captures these at import time. This focused integration test uses its
// own fake CLI and data directory, never a user's normal service state.
process.env.AGETOR_DATA_DIR = mkdtempSync(path.join(tmpdir(), "agetor-done-followups-orchestrator-"));
process.env.AGETOR_CLAUDE_DRIVER = "fake";
process.env.AGETOR_CLAUDE_BIN = "/bin/echo";
process.env.AGETOR_TMUX_BIN = "/bin/echo";
process.env.AGETOR_CLAUDE_ARGS = "";

test("an opted-in normal run snapshots and injects the Done-follow-up protocol", async () => {
  const { createTask, startTask } = await import("./orchestrator.ts");
  const { FAKE_CLAUDE_DONE_FOLLOWUPS_PROMPT_MARKER } = await import("./agents.ts");
  const { db, runs, tasks } = await import("./db.ts");
  const { getDoneFollowupSummary } = await import("./done-followups.ts");

  // The fake agent only emits its envelope when this user-controlled variant
  // selector AND the server-injected production protocol marker are present.
  // A missing appendDoneFollowupsPrompt call therefore fails this integration
  // test instead of being masked by the test fixture's own prompt text.
  const created = await createTask({
    title: "snapshot and inject Done follow-ups",
    prompt: FAKE_CLAUDE_DONE_FOLLOWUPS_PROMPT_MARKER,
    agent: "claude-code",
    workdir: process.cwd(),
    isolation: "none",
    doneFollowupsEnabled: true,
  });
  if ("error" in created) throw new Error(created.error);

  try {
    const started = await startTask(created.task.id);
    if (!("runId" in started)) throw new Error("expected opted-in task to start");
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(tasks.get(created.task.id)?.column).toBe("review");
    expect(runs.get(started.runId)?.doneFollowupsEnabled).toBe(true);
    expect(getDoneFollowupSummary(created.task.id)).toMatchObject({
      collection: { status: "collected" },
      generated: [],
    });
    expect(getDoneFollowupSummary(created.task.id)?.collection?.candidates).toHaveLength(2);
  } finally {
    // This test database deliberately has no FK on audit history, so remove
    // the focused fixture rows explicitly after the normal run settles.
    const runId = tasks.get(created.task.id)?.runId;
    if (runId) {
      db.run("DELETE FROM done_followup_generated_tasks WHERE source_run_id = ?", [runId]);
      db.run("DELETE FROM done_followup_requests WHERE source_run_id = ?", [runId]);
      db.run("DELETE FROM done_followup_candidates WHERE run_id = ?", [runId]);
      db.run("DELETE FROM done_followup_collections WHERE run_id = ?", [runId]);
    }
    db.run("DELETE FROM tasks WHERE id = ?", [created.task.id]);
  }
});
