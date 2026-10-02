import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePublicOrigin, startWebServer } from "./web-server.ts";

// The browser DOM declaration otherwise hides Bun's test-client headers option.
const TestWebSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };

// The browser boundary is exercised against an inert HTTP/WebSocket backend:
// these tests cannot start agents, send notifications, or contact GitHub.
const root = mkdtempSync(path.join(tmpdir(), "kaname-web-test-"));
const dataDir = path.join(root, "data");
const staticDir = path.join(root, "static");
const backendToken = "test-backend-secret";
let now = 1_800_000_000_000;
let backend: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof startWebServer>;
let publicGateway: ReturnType<typeof startWebServer>;
let loginToken = "";
let publicLoginToken = "";
let upstreamAborted = false;
const publicOrigin = "https://kaname.example.com";
const publicBase = () => `http://127.0.0.1:${publicGateway.port}`;
// Emulate the HTTP hop after TLS termination: preserve the external Host and Origin.
const publicHeaders = (cookie?: string): Record<string, string> => ({
  host: new URL(publicOrigin).host,
  origin: publicOrigin,
  "content-type": "application/json",
  ...(cookie ? { cookie } : {}),
});

async function publicLogin() {
  const response = await fetch(`${publicBase()}/auth/login`, {
    method: "POST", headers: publicHeaders(), body: JSON.stringify({ token: publicLoginToken }),
  });
  expect(response.status).toBe(200);
  return { response, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

const base = () => `http://127.0.0.1:${gateway.port}`;
const headers = (cookie?: string): Record<string, string> => ({
  origin: base(),
  "content-type": "application/json",
  ...(cookie ? { cookie } : {}),
});

async function login(): Promise<{ cookie: string; response: Response }> {
  const response = await fetch(`${base()}/auth/login`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ token: loginToken }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).not.toBeNull();
  return { cookie: setCookie!.split(";")[0]!, response };
}

beforeAll(() => {
  mkdirSync(dataDir);
  mkdirSync(staticDir);
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>KANAME fixture</title>");
  writeFileSync(path.join(staticDir, "asset.js"), "window.fixture = true;");
  writeFileSync(path.join(root, "private.txt"), "OUTSIDE_STATIC_SECRET");
  symlinkSync(path.join(root, "private.txt"), path.join(staticDir, "escape.txt"));
  backend = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/terminals/fixture/ws") {
        if (req.headers.get("authorization") !== `Bearer ${backendToken}` && url.searchParams.get("token") !== backendToken) {
          return new Response("unauthorized", { status: 401 });
        }
        if (server.upgrade(req, { data: undefined })) return undefined;
        return new Response("upgrade required", { status: 426 });
      }
      if (url.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\ndata: {\"fixture\":true}\n\n"));
            req.signal.addEventListener("abort", () => {
              upstreamAborted = true;
              controller.close();
            }, { once: true });
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        path: url.pathname,
        query: url.search,
        body: await req.text(),
        authorization: req.headers.get("authorization"),
        cookie: req.headers.get("cookie"),
        lastEventId: req.headers.get("last-event-id"),
      }, { headers: {
        "access-control-allow-origin": "null",
        "access-control-allow-credentials": "true",
        "set-cookie": "backend-secret=do-not-forward",
        "content-security-policy": "sandbox; default-src 'none'",
      } });
    },
    websocket: { message(ws, message) { ws.send(message); } },
  });
  gateway = startWebServer({
    port: 0, dataDir, staticDir,
    backendUrl: `http://127.0.0.1:${backend.port}`,
    backendToken,
    sessionTtlMs: 60_000,
    now: () => now,
  });
  loginToken = readFileSync(path.join(dataDir, "web-login-token"), "utf8").trim();
  const publicDataDir = path.join(root, "public-data");
  publicGateway = startWebServer({
    port: 0, dataDir: publicDataDir, staticDir, publicOrigin,
    backendUrl: `http://127.0.0.1:${backend.port}`, backendToken,
  });
  publicLoginToken = readFileSync(path.join(publicDataDir, "web-login-token"), "utf8").trim();
});

afterAll(() => {
  gateway?.stop(true);
  publicGateway?.stop(true);
  backend?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("the public application loads, but API and SSE require a browser session", async () => {
  expect(await (await fetch(base())).text()).toContain("KANAME fixture");
  for (const route of ["/api/tasks", "/api/events", `/api/tasks?token=${backendToken}`]) {
    const response = await fetch(`${base()}${route}`, {
      headers: { authorization: `Bearer ${backendToken}` },
    });
    expect(response.status).toBe(401);
  }
});

test("browser credentials and persisted sessions are private to the service user", () => {
  expect(statSync(path.join(dataDir, "web-login-token")).mode & 0o777).toBe(0o600);
  expect(statSync(path.join(dataDir, "web-sessions.sqlite")).mode & 0o777).toBe(0o600);
});

test("login rejects wrong secrets and foreign, null, or missing Origin", async () => {
  for (const origin of ["http://evil.invalid", "null", undefined]) {
    const response = await fetch(`${base()}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ token: loginToken }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  const response = await fetch(`${base()}/auth/login`, {
    method: "POST", headers: headers(), body: JSON.stringify({ token: "wrong" }),
  });
  expect(response.status).toBe(401);
});

test("login creates an HttpOnly, SameSite session without returning the login secret", async () => {
  const { cookie, response } = await login();
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/i);
  expect(response.headers.get("set-cookie")).toMatch(/Path=\//i);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.text()).not.toContain(loginToken);
  expect(cookie).not.toContain(loginToken);
  const session = await fetch(`${base()}/auth/session`, { headers: { cookie } });
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual({ authenticated: true });
});

test("an authenticated session cannot bypass Host or same-origin mutation checks", async () => {
  const { cookie } = await login();
  const foreignHost = await fetch(`${base()}/api/tasks`, { headers: { cookie, host: "evil.invalid" } });
  expect(foreignHost.status).toBe(403);
  for (const origin of ["http://evil.invalid", "http://127.0.0.1:1", "null", undefined]) {
    const response = await fetch(`${base()}/api/tasks`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: "{}",
    });
    expect(response.status).toBe(403);
  }
});

test("the proxy owns backend credentials and removes backend CORS/cookies", async () => {
  const { cookie } = await login();
  const response = await fetch(`${base()}/api/tasks?token=caller-secret&limit=5`, {
    headers: { ...headers(cookie), authorization: "Bearer caller-secret", "last-event-id": "event-7" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    path: "/tasks", query: "?limit=5", body: "", authorization: `Bearer ${backendToken}`,
    cookie: null, lastEventId: "event-7",
  });
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
});

test("logout invalidates the server session and expiry rejects an old cookie", async () => {
  const { cookie } = await login();
  const logout = await fetch(`${base()}/auth/logout`, { method: "POST", headers: headers(cookie) });
  expect(logout.status).toBe(200);
  expect((await fetch(`${base()}/api/tasks`, { headers: { cookie } })).status).toBe(401);
  const another = await login();
  now += 60_001;
  expect((await fetch(`${base()}/api/tasks`, { headers: { cookie: another.cookie } })).status).toBe(401);
});

test("a browser session survives gateway recreation using the same state directory", async () => {
  const { cookie } = await login();
  const port = gateway.port!;
  gateway.stop(true);
  gateway = startWebServer({
    port, dataDir, staticDir,
    backendUrl: `http://127.0.0.1:${backend.port}`,
    backendToken, sessionTtlMs: 60_000, now: () => now,
  });
  expect(readFileSync(path.join(dataDir, "web-login-token"), "utf8").trim()).toBe(loginToken);
  expect((await fetch(`${base()}/api/tasks`, { headers: { cookie } })).status).toBe(200);
});

test("SSE flushes without buffering and disconnect aborts the upstream stream", async () => {
  const { cookie } = await login();
  upstreamAborted = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${base()}/api/events`, { headers: { cookie }, signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain(": connected");
    await reader.cancel();
    controller.abort();
    for (let attempt = 0; attempt < 50 && !upstreamAborted; attempt++) await Bun.sleep(10);
    expect(upstreamAborted).toBe(true);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
});

test("logout closes an already authenticated SSE stream", async () => {
  const { cookie } = await login();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${base()}/api/events`, { headers: { cookie }, signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    upstreamAborted = false;
    const closed = reader.read().then(result => result.done, () => true);
    const logout = await fetch(`${base()}/auth/logout`, { method: "POST", headers: headers(cookie) });
    expect(logout.status).toBe(200);
    expect(await closed).toBe(true);
    for (let attempt = 0; attempt < 50 && !upstreamAborted; attempt++) await Bun.sleep(10);
    expect(upstreamAborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
});

test("static file serving refuses symlink escapes and encoded traversal", async () => {
  for (const route of ["/escape.txt", "/%2e%2e/private.txt", "/..%2fprivate.txt", "/%2e%2e%2fprivate.txt"]) {
    const response = await fetch(`${base()}${route}`);
    expect(await response.text()).not.toContain("OUTSIDE_STATIC_SECRET");
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
});

test("WebSocket upgrade requires session and same-origin Origin", async () => {
  const { cookie } = await login();
  const attempts: Record<string, string>[] = [
    { origin: base() },
    { cookie, origin: "http://evil.invalid" },
    { cookie, origin: "null" },
  ];
  for (const requestHeaders of attempts) {
    const response = await fetch(`${base()}/api/terminals/fixture/ws`, { headers: {
      ...requestHeaders, connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13",
    } });
    expect([401, 403]).toContain(response.status);
  }
});

test("authenticated WebSocket relays text and binary messages", async () => {
  const { cookie } = await login();
  const ws = new TestWebSocket(`${base().replace("http:", "ws:")}/api/terminals/fixture/ws`, {
    headers: { cookie, origin: base() },
  });
  ws.binaryType = "arraybuffer";
  try {
    const received = await new Promise<Array<string | Uint8Array>>((resolve, reject) => {
      const messages: Array<string | Uint8Array> = [];
      const timeout = setTimeout(() => reject(new Error("WebSocket relay timed out")), 2_000);
      ws.onopen = () => { ws.send("fixture-text"); ws.send(new Uint8Array([1, 2, 3])); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket relay failed")); };
      ws.onmessage = (event) => {
        messages.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
        if (messages.length === 2) { clearTimeout(timeout); resolve(messages); }
      };
    });
    expect(received).toEqual(["fixture-text", new Uint8Array([1, 2, 3])]);
  } finally {
    ws.close();
  }
});

test("logout and expiry close an already authenticated WebSocket", async () => {
  for (const action of ["logout", "expire"] as const) {
    const { cookie } = await login();
    const ws = new TestWebSocket(`${base().replace("http:", "ws:")}/api/terminals/fixture/ws`, {
      headers: { cookie, origin: base() },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = new Promise<number>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${action} did not close the socket`)), 3_000);
        ws.onclose = event => resolve(event.code);
        ws.onerror = () => reject(new Error("WebSocket could not connect"));
      });
      await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
      if (action === "logout") {
        expect((await fetch(`${base()}/auth/logout`, { method: "POST", headers: headers(cookie) })).status).toBe(200);
      } else now += 60_001;
      expect(await closed).toBe(1008);
    } finally {
      clearTimeout(timeout);
      ws.close();
    }
  }
});

test("public origin configuration rejects noncanonical URLs before starting a gateway", () => {
  expect(parsePublicOrigin(undefined)).toBeUndefined();
  expect(parsePublicOrigin(publicOrigin)?.origin).toBe(publicOrigin);
  expect(parsePublicOrigin("https://kaname.example.com:8443")?.host).toBe("kaname.example.com:8443");
  for (const value of [
    "", "kaname.example.com", "http://kaname.example.com", "https://kaname.example.com/",
    "https://kaname.example.com/path", "https://kaname.example.com?", "https://kaname.example.com#",
    "https://name:secret@kaname.example.com", "https://kaname.example.com:443", " https://kaname.example.com",
    "https://kaname.example.com\\path", "https://KANAME.example.com",
  ]) {
    expect(() => parsePublicOrigin(value)).toThrow("KANAME_PUBLIC_ORIGIN");
  }
});

test("the configured HTTPS origin authenticates and proxies through loopback HTTP", async () => {
  expect(publicGateway.hostname).toBe("127.0.0.1");
  expect(await (await fetch(publicBase(), { headers: publicHeaders() })).text()).toContain("KANAME fixture");
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: publicHeaders() })).status).toBe(401);
  const { cookie, response } = await publicLogin();
  expect(cookie.startsWith(`__Host-kaname_session_${publicGateway.port}=`)).toBe(true);
  expect(response.headers.get("set-cookie")).toContain("; Secure");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect(response.headers.get("set-cookie")).not.toContain("Domain=");
  expect(await (await fetch(`${publicBase()}/auth/session`, { headers: publicHeaders(cookie) })).json())
    .toEqual({ authenticated: true });
  const api = await fetch(`${publicBase()}/api/tasks?token=caller-secret`, {
    method: "POST", headers: { ...publicHeaders(cookie), authorization: "Bearer caller-secret" }, body: "{}",
  });
  expect(api.status).toBe(200);
  expect(await api.json()).toMatchObject({ path: "/tasks", query: "", body: "{}", authorization: `Bearer ${backendToken}`, cookie: null });
  const logout = await fetch(`${publicBase()}/auth/logout`, { method: "POST", headers: publicHeaders(cookie) });
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0; Secure");
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: publicHeaders(cookie) })).status).toBe(401);
});

test("public HTTPS configuration preserves local HTTP login and does not trust forwarded headers", async () => {
  const response = await fetch(`${publicBase()}/auth/login`, {
    method: "POST", headers: { origin: publicBase(), "content-type": "application/json" },
    body: JSON.stringify({ token: publicLoginToken }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).not.toContain("; Secure");
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie.startsWith(`kaname_session_${publicGateway.port}=`)).toBe(true);
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: { cookie } })).status).toBe(200);
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: publicHeaders(cookie) })).status).toBe(401);
  const { cookie: publicCookie } = await publicLogin();
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: { cookie: publicCookie } })).status).toBe(401);
  const forwarded = {
    "x-forwarded-host": "evil.invalid", "x-forwarded-proto": "https",
    forwarded: 'host="evil.invalid";proto=https',
  };
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: { ...publicHeaders(`${cookie}; ${publicCookie}`), ...forwarded } })).status).toBe(200);
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: { cookie, ...forwarded, origin: "https://evil.invalid" } })).status).toBe(403);
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: {
    cookie: publicCookie, host: "evil.invalid", origin: publicOrigin, "x-forwarded-host": "kaname.example.com", "x-forwarded-proto": "https",
  } })).status).toBe(403);
  // No public host is admitted at all unless explicitly configured.
  expect((await fetch(`${base()}/auth/session`, { headers: publicHeaders() })).status).toBe(403);
});

test("public mutations and WebSocket upgrades reject mismatched, missing and insecure origins", async () => {
  const { cookie } = await publicLogin();
  for (const origin of ["https://evil.invalid", "http://kaname.example.com", "https://kaname.example.com:8443", publicBase(), "null", undefined]) {
    const requestHeaders = publicHeaders(cookie);
    delete requestHeaders.origin;
    if (origin !== undefined) requestHeaders.origin = origin;
    for (const route of ["/auth/login", "/auth/logout", "/api/tasks"]) {
      const response = await fetch(`${publicBase()}${route}`, {
        method: "POST", headers: requestHeaders, body: JSON.stringify({ token: publicLoginToken }),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    const upgrade = await fetch(`${publicBase()}/api/terminals/fixture/ws`, { headers: {
      ...requestHeaders, connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13",
    } });
    expect(upgrade.status).toBe(403);
  }
  expect((await fetch(`${publicBase()}/api/tasks`, { headers: { ...publicHeaders(cookie), "sec-fetch-site": "cross-site" } })).status).toBe(403);
  const unauthenticated = await fetch(`${publicBase()}/api/terminals/fixture/ws`, { headers: {
    ...publicHeaders(), connection: "Upgrade", upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13",
  } });
  expect(unauthenticated.status).toBe(401);
});

test("public-origin SSE streams immediately and logout revokes the stream", async () => {
  const { cookie } = await publicLogin();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${publicBase()}/api/events`, { headers: publicHeaders(cookie), signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    const closed = reader.read().then(result => result.done, () => true);
    expect((await fetch(`${publicBase()}/auth/logout`, { method: "POST", headers: publicHeaders(cookie) })).status).toBe(200);
    expect(await closed).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  } finally { clearTimeout(timeout); controller.abort(); }
});

test("public-origin WebSocket relays messages and logout closes it", async () => {
  const { cookie } = await publicLogin();
  const ws = new TestWebSocket(`${publicBase().replace("http:", "ws:")}/api/terminals/fixture/ws`, {
    headers: publicHeaders(cookie),
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Public WebSocket relay timed out")), 2_000);
      ws.onopen = () => ws.send("public-fixture");
      ws.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error("Public WebSocket relay failed")); };
    });
    expect(await message).toBe("public-fixture");
    const closed = new Promise<number>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Public logout did not close WebSocket")), 2_000);
      ws.onclose = event => resolve(event.code);
    });
    expect((await fetch(`${publicBase()}/auth/logout`, { method: "POST", headers: publicHeaders(cookie) })).status).toBe(200);
    expect(await closed).toBe(1008);
  } finally { clearTimeout(timeout); ws.close(); }
});

test("an unavailable backend returns a retryable failure without exposing credentials", async () => {
  const { cookie } = await login();
  await backend.stop(true);
  const response = await fetch(`${base()}/api/tasks`, { headers: { cookie } });
  expect(response.status).toBe(502);
  const body = await response.text();
  expect(body).not.toContain(backendToken);
  expect(body).not.toContain(loginToken);
});
