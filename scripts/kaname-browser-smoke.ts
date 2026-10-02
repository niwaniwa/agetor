// Real Chromium + KANAME gateway/UI, isolated SQLite and fake CLI drivers.
// Run after `bun run build:web`; no provider requests or Git writes.
// PLAYWRIGHT_BROWSERS_PATH may point at a temporary browser installation.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { chromium, expect, type Browser, type Page } from "@playwright/test";

const scratch = mkdtempSync(path.join(tmpdir(), "kaname-browser-"));
const dataDir = path.join(scratch, "data");
const workdir = path.join(scratch, "project");
mkdirSync(workdir);
const reservePort = () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
};
const apiPort = reservePort();
const webPort = reservePort();
const origin = `http://127.0.0.1:${webPort}`;
const tmuxSocket = `kaname-browser-${process.pid}`;
let service: ReturnType<typeof Bun.spawn> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
const checks: string[] = [];
const errors: string[] = [];
const consoleErrors: string[] = [];
const requests: string[] = [];

async function api(route: string, method = "GET", body?: unknown): Promise<any> {
  return page!.evaluate(async ({ route, method, body }) => {
    const response = await fetch(`/api${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }, { route, method, body });
}

try {
  const startService = () => Bun.spawn([process.execPath, "src/bun/kaname.ts"], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      AGETOR_DATA_DIR: dataDir, AGETOR_API_PORT: String(apiPort), KANAME_WEB_PORT: String(webPort),
      AGETOR_TMUX_SOCKET: tmuxSocket, AGETOR_BACKGROUND_DISCOVERY: "0", AGETOR_TRACK_SUBAGENTS: "0",
      AGETOR_CODEX_DRIVER: "fake", AGETOR_CODEX_BIN: "/bin/echo",
      AGETOR_CLAUDE_DRIVER: "fake", AGETOR_CLAUDE_BIN: "/bin/echo",
      AGETOR_SKIP_CLI_VERSION_FLOOR: "1", AGETOR_FAKE_CODEX_RESOLVE_DELAY_MS: "120000",
    },
    stdout: Bun.file(path.join(scratch, "service.log")),
    stderr: Bun.file(path.join(scratch, "service.log")),
  });
  service = startService();
  await expect.poll(() => fetch(origin + "/auth/session").then(r => r.ok).catch(() => false), { timeout: 30_000 }).toBe(true);
  const db = new Database(path.join(dataDir, "agetor.sqlite"));
  db.run("UPDATE harnesses SET enabled = 1 WHERE id = 'codex'");
  db.close();
  const token = readFileSync(path.join(dataDir, "web-login-token"), "utf8").trim();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // Any unexpected external resource is blocked, making the mock boundary
  // explicit even if a future UI starts loading external images/fonts.
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", request => requests.push(request.url()));
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "KANAME", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await page.getByLabel("Access token").fill("invalid-token");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid access token.");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip — I know my way around", exact: true }).click();
  assert.equal(await page.evaluate(() => document.cookie), "", "HttpOnly cookie is unavailable to JavaScript");
  assert.equal(await page.evaluate((token) => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => String(value).includes(token)), token), false, "Login token is not saved in browser storage");
  checks.push("login gate, invalid token rejection, HttpOnly session");

  const form = page.locator("aside").filter({ hasText: "New task" });
  await form.getByTitle("Pick the working directory the agent runs in. Add new ones with the folder picker at the bottom of the list.").click();
  await page.getByRole("button", { name: "Add server directory…", exact: true }).click();
  await page.getByLabel("Server directory", { exact: true }).fill(workdir);
  await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await form.getByTestId("isolate-toggle").uncheck();
  checks.push("server directory registration through browser dialog");

  async function fillTask(title: string, harness: RegExp) {
    await form.getByPlaceholder("Short description").fill(title);
    await form.getByTestId("prompt-textarea").fill(title);
    await form.getByRole("button", { name: harness }).click();
    await form.getByTestId("isolate-toggle").uncheck();
  }
  const codexTitle = "KANAME browser mock Codex";
  await fillTask(codexTitle, /^Codex$/i);
  await form.getByRole("button", { name: "To backlog", exact: true }).click();
  await expect.poll(async () => (await api("/tasks")).find((task: any) => task.title === codexTitle)?.column).toBe("backlog");
  const task = (await api("/tasks")).find((task: any) => task.title === codexTitle);
  assert.equal((await api(`/tasks/${task.id}/runs`)).length, 0);
  const card = page.locator('[aria-roledescription="draggable"]').filter({ hasText: codexTitle });
  await card.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(async () => (await api(`/tasks/${task.id}/runs`))[0]?.status).toBe("running");
  await page.getByText(codexTitle, { exact: true }).first().click();
  await expect(page.getByText(`fake response to: ${codexTitle}`, { exact: true })).toBeVisible();
  checks.push("Backlog stays idle; Codex starts from board and shows logs");

  await page.reload();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await page.getByText(codexTitle, { exact: true }).first().click();
  await expect(page.getByText(`fake response to: ${codexTitle}`, { exact: true })).toBeVisible();
  assert.equal((await api(`/tasks/${task.id}/runs`)).length, 1);
  checks.push("reload preserves cookie, running task and replayed logs");

  await context.setOffline(true);
  await expect(page.getByText(/Connection lost|Failed to fetch|Could not check the session/)).toBeVisible();
  await context.setOffline(false);
  await expect.poll(async () => (await api(`/tasks/${task.id}/runs`))[0]?.status).toBe("running");
  await expect(page.getByText(`fake response to: ${codexTitle}`, { exact: true })).toHaveCount(1);
  checks.push("offline/online reconnect restores state without duplicate log");
  await page.locator("aside").last().getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await api(`/tasks/${task.id}/runs`))[0]?.status).toBe("cancelled");
  await page.getByRole("button", { name: "Close task panel", exact: true }).click({ position: { x: 10, y: 100 } });
  checks.push("Codex stop through browser");

  const claudeTitle = "KANAME browser mock Claude";
  await fillTask(claudeTitle, /^Claude Code$/i);
  await form.getByRole("button", { name: "Run task", exact: true }).click();
  await expect.poll(async () => (await api("/tasks")).find((item: any) => item.title === claudeTitle)?.column).toBe("review");
  await page.getByText(claudeTitle, { exact: true }).first().click();
  await expect(page.getByText(`fake response to: ${claudeTitle}`, { exact: true })).toBeVisible();
  checks.push("Claude starts and completes with visible replayed log");
  // Unlike DevTools' offline mode (which may leave existing SSE sockets
  // intact), stopping the actual service forces EventSource to reconnect.
  service.kill("SIGTERM");
  await service.exited;
  await expect(page.getByText(/Connection lost|Failed to fetch|Could not check the session/)).toBeVisible();
  await Bun.sleep(200); // Allow the singleton-lock guardian to observe EOF.
  service = startService();
  await expect.poll(() => fetch(origin + "/auth/session").then(r => r.ok).catch(() => false), { timeout: 30_000 }).toBe(true);
  await expect(page.getByText(/Connection lost|Failed to fetch|Could not check the session/)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(`fake response to: ${claudeTitle}`, { exact: true })).toHaveCount(1);
  assert.equal((await api(`/tasks/${task.id}/runs`))[0]?.status, "cancelled");
  checks.push("service restart reconnects SSE, preserves session and cancelled state, deduplicates replay");
  await page.screenshot({ path: path.join(scratch, "browser.png"), fullPage: true });
  await page.getByRole("button", { name: "Close task panel", exact: true }).click({ position: { x: 10, y: 100 } });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Access token")).toBeVisible();
  assert.equal(await page.evaluate(() => fetch("/api/tasks").then(r => r.status)), 401);
  assert.ok(requests.every(url => !url.includes(token) && !new URL(url).searchParams.has("token")), "No token in any resource URL");
  assert.deepEqual(errors, [], "No uncaught browser exceptions");
  checks.push("logout rejects API access; no URL token leakage or browser exceptions");
  const result = { ok: true, scratch, checks, requestCount: requests.length };
  writeFileSync(path.join(scratch, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(scratch, "failure.png"), fullPage: true }).catch(() => {});
    writeFileSync(path.join(scratch, "failure-dom.txt"), await page.locator("body").innerText().catch(() => ""));
    writeFileSync(path.join(scratch, "failure-debug.json"), JSON.stringify({ errors, consoleErrors, state: await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return { htmlFont: getComputedStyle(document.documentElement).fontSize, heading: h1 ? { rect: h1.getBoundingClientRect().toJSON(), style: { fontSize: getComputedStyle(h1).fontSize, visibility: getComputedStyle(h1).visibility, display: getComputedStyle(h1).display } } : null };
    }).catch(() => null) }, null, 2));
  }
  console.error(`Browser smoke failed. Artifacts: ${scratch}`);
  throw error;
} finally {
  await browser?.close();
  if (service) { service.kill("SIGTERM"); await service.exited; }
  await Bun.spawn(["tmux", "-L", tmuxSocket, "kill-server"], { stdout: "ignore", stderr: "ignore" }).exited;
}
