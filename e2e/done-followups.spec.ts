import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { test, expect, type APIRequestContext, type E2EBackend, type Locator, type Page } from "./fixtures";
import { gotoApp } from "./helpers";

// Kept literal rather than imported from src/bun/agents.ts: Playwright runs
// this file under Node, which cannot load Bun-only modules. See the matching
// fake-driver marker's comment for why prompt markers are the e2e seam.
const FAKE_CLAUDE_DONE_FOLLOWUPS_PROMPT_MARKER = "__agetor_fake_done_followups__";

test.describe.configure({ mode: "serial" });

interface TaskRow {
  id: string;
  title: string;
  column?: string;
  doneFollowupsEnabled?: boolean;
  runId?: string | null;
}

interface DoneFollowupsSummary {
  collection: {
    status: "collected" | "failed";
    candidates: Array<{ id: string; title: string }>;
  } | null;
  request: { status: string } | null;
  generated: Array<{ generatedTaskId: string }>;
}

function auth(backend: E2EBackend) {
  return { authorization: `Bearer ${backend.apiToken}` };
}

function runPanel(page: Page) {
  // NewTaskForm is also an aside; the RunPanel is mounted after it.
  return page.locator("aside").last();
}

function taskCard(page: Page, title: string): Locator {
  return page.locator(".cursor-grab").filter({ has: page.getByText(title, { exact: true }) });
}

async function getTask(request: APIRequestContext, backend: E2EBackend, id: string): Promise<TaskRow> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return await res.json() as TaskRow;
}

async function getSummary(
  request: APIRequestContext,
  backend: E2EBackend,
  id: string,
): Promise<DoneFollowupsSummary> {
  const res = await request.get(`${backend.apiBase}/tasks/${id}/done-followups`, { headers: auth(backend) });
  expect(res.ok(), `GET /tasks/${id}/done-followups -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return await res.json() as DoneFollowupsSummary;
}

async function openTask(page: Page, title: string) {
  await taskCard(page, title).getByText(title, { exact: true }).click();
  const panel = runPanel(page);
  await expect(panel.locator("textarea")).toBeVisible();
  return panel;
}

async function closeTask(panel: Locator) {
  await panel.getByRole("button", { name: "Close task details" }).click();
  await expect(panel).toHaveClass(/translate-x-full/);
}

test.describe("Done follow-up tasks", () => {
  test("a user opt-in reaches Review as candidates, then Done creates independent Backlog tasks", async ({
    page,
    request,
    backend,
  }) => {
    const title = `done-followups-e2e ${randomUUID()}`;
    const createdTaskIds: string[] = [];
    try {
      // The creation form starts visibly OFF for the default Claude Code
      // harness. The actual task is created via the authenticated API below
      // so this test can exercise the task-detail switch before its first run.
      await gotoApp(page, backend.bootBase);
      const newTaskSwitch = page.getByTestId("new-task-done-followups")
        .getByRole("switch", { name: "Create follow-up tasks when Done" });
      await expect(newTaskSwitch).toBeVisible();
      await expect(newTaskSwitch).toHaveAttribute("data-state", "unchecked");

      const createRes = await request.post(`${backend.apiBase}/tasks`, {
        headers: auth(backend),
        data: {
          title,
          prompt: `${FAKE_CLAUDE_DONE_FOLLOWUPS_PROMPT_MARKER} ${title}`,
          isolation: "none",
          workdir: tmpdir(),
        },
      });
      expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
      const source = await createRes.json() as TaskRow;
      createdTaskIds.push(source.id);
      expect(source.doneFollowupsEnabled ?? false).toBe(false);

      // Enable through the detail UI while the task is idle, not by injecting
      // a create payload. The server snapshots it only when the run begins.
      const idlePanel = await openTask(page, title);
      await idlePanel.getByText("Task details", { exact: true }).click();
      const detailSwitch = idlePanel.getByTestId("task-done-followups")
        .getByRole("switch", { name: "Create follow-up tasks when Done" });
      await expect(detailSwitch).toHaveAttribute("data-state", "unchecked");
      await detailSwitch.click();
      await expect.poll(
        () => getTask(request, backend, source.id).then((task) => task.doneFollowupsEnabled),
      ).toBe(true);
      // The detail-panel fetch must react to the optimistic switch change;
      // it cannot wait for a later column transition to reveal the setting.
      await expect(idlePanel.getByTestId("done-followups-panel")).toBeVisible();
      await expect(idlePanel.getByText("Candidates will be collected only after a new successful run.")).toBeVisible();
      await closeTask(idlePanel);

      // Start through the normal board control as well: the fake agent is
      // still isolated inside this worker's backend, but this proves the
      // browser's explicit Run action snapshots the switch before it emits
      // the protocol-bearing prompt.
      await taskCard(page, title).getByRole("button", { name: "Run", exact: true }).click();

      // The fake driver emits two valid candidates. They must be persisted in
      // Review before the human's Done action, with no generated tasks yet.
      await expect(async () => {
        const task = await getTask(request, backend, source.id);
        expect(task.column).toBe("review");
        const summary = await getSummary(request, backend, source.id);
        expect(summary.collection?.status).toBe("collected");
        expect(summary.collection?.candidates).toHaveLength(2);
        expect(summary.request).toBeNull();
        expect(summary.generated).toHaveLength(0);
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200] });

      const reviewPanel = await openTask(page, title);
      await expect(reviewPanel.getByTestId("done-followups-panel")).toBeVisible();
      await expect(reviewPanel.getByTestId("done-followups-candidates")).toContainText("Fake follow-up 1");
      await expect(reviewPanel.getByText("Nothing is created until you mark this task Done.")).toBeVisible();
      await closeTask(reviewPanel);

      // This is the actual browser Done control; it is deliberately not an
      // API shortcut so it proves the UI's normal Done path uses the durable
      // server-side processor as well.
      await taskCard(page, title).getByRole("button", { name: "Done" }).click();
      let finalSummary: DoneFollowupsSummary | null = null;
      await expect(async () => {
        const task = await getTask(request, backend, source.id);
        expect(task.column).toBe("done");
        const summary = await getSummary(request, backend, source.id);
        expect(summary.request?.status).toBe("succeeded");
        expect(summary.generated).toHaveLength(2);
        finalSummary = summary;
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200] });

      const generatedIds = finalSummary!.generated.map((link) => link.generatedTaskId);
      createdTaskIds.push(...generatedIds);
      for (const id of generatedIds) {
        const target = await getTask(request, backend, id);
        expect(target.column).toBe("backlog");
        expect(target.doneFollowupsEnabled ?? false).toBe(false);
        expect(target.runId ?? null).toBeNull();
        await expect(page.getByText(target.title, { exact: true })).toBeVisible();
      }

      const donePanel = await openTask(page, title);
      await expect(donePanel.getByTestId("done-followups-request-succeeded")).toBeVisible();
      const generatedLink = donePanel.getByTestId(`done-followup-generated-${generatedIds[0]!}`);
      await expect(generatedLink).toBeVisible();

      // The durable link navigates to the ordinary opt-out Backlog task, and
      // its reverse link returns to this source task without relying on a
      // board-card lookup.
      await generatedLink.click();
      const generatedPanel = runPanel(page);
      await expect(generatedPanel.getByTestId("done-followups-sources")).toContainText(source.id);
      await generatedPanel.getByTestId(`done-followup-source-${source.id}`).click();
      const sourcePanel = runPanel(page);
      await expect(sourcePanel.getByTestId("done-followups-request-succeeded")).toBeVisible();
      await closeTask(sourcePanel);
    } finally {
      // The worker fixture is shared by this spec's tests; remove the source
      // and targets so later specs don't inherit extra board cards.
      for (const id of [...createdTaskIds].reverse()) {
        await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) }).catch(() => {});
      }
    }
  });

  test("zero and rejected fake envelopes remain distinct and never infer a Backlog task", async ({
    page,
    request,
    backend,
  }) => {
    const zeroTitle = `done-followups-zero ${randomUUID()}`;
    const invalidTitle = `done-followups-invalid ${randomUUID()}`;
    const tooManyTitle = `done-followups-too-many ${randomUUID()}`;
    const createdTaskIds: string[] = [];
    try {
      await gotoApp(page, backend.bootBase);
      for (const [title, variant] of [
        [zeroTitle, ":zero"],
        [invalidTitle, ":invalid"],
        [tooManyTitle, ":too-many"],
      ] as const) {
        const createRes = await request.post(`${backend.apiBase}/tasks`, {
          headers: auth(backend),
          data: {
            title,
            prompt: `${FAKE_CLAUDE_DONE_FOLLOWUPS_PROMPT_MARKER}${variant}`,
            isolation: "none",
            workdir: tmpdir(),
            doneFollowupsEnabled: true,
          },
        });
        expect(createRes.ok(), `POST /tasks -> ${createRes.status()}: ${await createRes.text()}`).toBeTruthy();
        const task = await createRes.json() as TaskRow;
        createdTaskIds.push(task.id);
        const startRes = await request.post(`${backend.apiBase}/tasks/${task.id}/start`, {
          headers: auth(backend),
        });
        expect(startRes.ok(), `POST /tasks/${task.id}/start -> ${startRes.status()}: ${await startRes.text()}`).toBeTruthy();
      }

      await expect(async () => {
        const zero = await getTask(request, backend, createdTaskIds[0]!);
        const invalid = await getTask(request, backend, createdTaskIds[1]!);
        const tooMany = await getTask(request, backend, createdTaskIds[2]!);
        expect(zero.column).toBe("review");
        expect(invalid.column).toBe("review");
        expect(tooMany.column).toBe("review");
        expect((await getSummary(request, backend, zero.id)).collection?.status).toBe("collected");
        expect((await getSummary(request, backend, invalid.id)).collection?.status).toBe("failed");
        expect((await getSummary(request, backend, tooMany.id)).collection?.status).toBe("failed");
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200] });

      const zeroPanel = await openTask(page, zeroTitle);
      await expect(zeroPanel.getByTestId("done-followups-zero")).toBeVisible();
      await closeTask(zeroPanel);
      const invalidPanel = await openTask(page, invalidTitle);
      await expect(invalidPanel.getByTestId("done-followups-collection-failed")).toBeVisible();
      await closeTask(invalidPanel);

      for (const id of createdTaskIds) {
        const doneRes = await request.patch(`${backend.apiBase}/tasks/${id}`, {
          headers: auth(backend),
          data: { column: "done" },
        });
        expect(doneRes.ok(), `PATCH /tasks/${id} -> ${doneRes.status()}: ${await doneRes.text()}`).toBeTruthy();
      }
      await expect(async () => {
        const zero = await getSummary(request, backend, createdTaskIds[0]!);
        const invalid = await getSummary(request, backend, createdTaskIds[1]!);
        const tooMany = await getSummary(request, backend, createdTaskIds[2]!);
        expect(zero.request?.status).toBe("succeeded");
        expect(zero.generated).toHaveLength(0);
        expect(invalid.generated).toHaveLength(0);
        expect(tooMany.generated).toHaveLength(0);
      }).toPass({ timeout: 10_000, intervals: [50, 100, 200] });
    } finally {
      for (const id of [...createdTaskIds].reverse()) {
        await request.delete(`${backend.apiBase}/tasks/${id}`, { headers: auth(backend) }).catch(() => {});
      }
    }
  });

  test("the API rejects opt-in for an unsupported harness and a pipeline task", async ({ request, backend }) => {
    const unsupported = await request.post(`${backend.apiBase}/tasks`, {
      headers: auth(backend),
      data: {
        title: `done-followups-unsupported ${randomUUID()}`,
        prompt: "This must be rejected before launch.",
        agent: "fx",
        isolation: "none",
        workdir: tmpdir(),
        doneFollowupsEnabled: true,
      },
    });
    expect(unsupported.status()).toBe(400);
    expect((await unsupported.json() as { error?: string }).error).toContain("ordinary Claude Code or Codex");

    let profileId: string | null = null;
    let pipelineId: string | null = null;
    let pipelineTaskId: string | null = null;
    try {
      const profileRes = await request.post(`${backend.apiBase}/agent-profiles`, {
        headers: auth(backend),
        data: {
          name: `done-followups-profile ${randomUUID()}`,
          harness: "claude-code",
          model: "opus-5",
          instructions: "",
          skills: [],
        },
      });
      expect(profileRes.ok(), `POST /agent-profiles -> ${profileRes.status()}: ${await profileRes.text()}`).toBeTruthy();
      profileId = (await profileRes.json() as { id: string }).id;

      const stepId = randomUUID();
      const pipelineRes = await request.post(`${backend.apiBase}/pipelines`, {
        headers: auth(backend),
        data: {
          name: `done-followups-pipeline ${randomUUID()}`,
          description: "",
          graph: {
            steps: [{
              id: stepId,
              name: "One step",
              instructions: "",
              agentProfileId: profileId,
              position: { x: 0, y: 0 },
              subagents: { profileIds: [], cap: null },
              transition: "choose",
              join: "any",
            }],
            edges: [],
            startStepId: stepId,
          },
        },
      });
      expect(pipelineRes.ok(), `POST /pipelines -> ${pipelineRes.status()}: ${await pipelineRes.text()}`).toBeTruthy();
      pipelineId = (await pipelineRes.json() as { id: string }).id;

      const taskRes = await request.post(`${backend.apiBase}/tasks`, {
        headers: auth(backend),
        data: {
          title: `done-followups-pipeline-task ${randomUUID()}`,
          prompt: "Pipeline task scope check.",
          isolation: "none",
          workdir: tmpdir(),
          pipelineId,
        },
      });
      expect(taskRes.ok(), `POST /tasks -> ${taskRes.status()}: ${await taskRes.text()}`).toBeTruthy();
      pipelineTaskId = (await taskRes.json() as TaskRow).id;

      const enablePipeline = await request.patch(`${backend.apiBase}/tasks/${pipelineTaskId}`, {
        headers: auth(backend),
        data: { doneFollowupsEnabled: true },
      });
      expect(enablePipeline.status()).toBe(400);
      expect((await enablePipeline.json() as { error?: string }).error).toContain("ordinary Claude Code or Codex");
    } finally {
      if (pipelineTaskId) {
        await request.delete(`${backend.apiBase}/tasks/${pipelineTaskId}`, { headers: auth(backend) }).catch(() => {});
      }
      if (pipelineId) {
        await request.delete(`${backend.apiBase}/pipelines/${pipelineId}`, { headers: auth(backend) }).catch(() => {});
      }
      if (profileId) {
        await request.delete(`${backend.apiBase}/agent-profiles/${profileId}`, { headers: auth(backend) }).catch(() => {});
      }
    }
  });
});
