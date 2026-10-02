import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { WebAuth } from "./web-auth.ts";

interface WebOptions {
  port: number;
  dataDir: string;
  staticDir: string;
  backendUrl: string;
  backendToken: string;
  /** Exact external HTTPS origin served by a trusted reverse proxy. */
  publicOrigin?: string;
  sessionTtlMs?: number;
  now?: () => number;
}
interface SocketData { session: string; upstreamUrl: string; upstream?: WebSocket; pending: Array<string | Buffer>; cleanup?: () => void }
// tsconfig also includes DOM, whose constructor hides Bun's server-side headers overload.
const BackendWebSocket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };

export function parsePublicOrigin(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    // Require an origin, not a URL with credentials, a path, or silent normalization.
    if (url.protocol === "https:" && url.origin === value) return url;
  } catch { /* Report one configuration error without echoing its contents. */ }
  throw new Error("KANAME_PUBLIC_ORIGIN must be an exact HTTPS origin, e.g. https://kaname.example.com (no trailing slash, credentials, path, query, or fragment)");
}

/** Loopback browser boundary. The existing CLI API remains private and unchanged. */
export function startWebServer(options: WebOptions) {
  const publicOrigin = parsePublicOrigin(options.publicOrigin);
  const root = realpathSync(options.staticDir);
  const index = readFileSync(path.join(root, "index.html"), "utf8");
  const backend = new URL(options.backendUrl);
  if (backend.protocol !== "http:" || backend.hostname !== "127.0.0.1") throw new Error("Backend must use loopback HTTP");
  const auth = new WebAuth(options);
  const connections = new Map<string, Set<() => void>>();
  const secureHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
  const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
    Response.json(body, { status, headers: { ...secureHeaders, ...headers } });
  const track = (session: string, stop: () => void) => {
    const set = connections.get(session) ?? new Set();
    set.add(stop); connections.set(session, set);
    return () => { set.delete(stop); if (!set.size) connections.delete(session); };
  };
  const disconnect = (session: string) => {
    for (const stop of [...connections.get(session) ?? []]) stop();
    connections.delete(session);
  };
  let failedLogins = 0;
  let loginWindow = 0;
  const now = options.now ?? Date.now;
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1", port: options.port, idleTimeout: 0, maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req, server) {
      const url = new URL(req.url);
      const host = req.headers.get("host");
      const allowedHosts = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
      const isPublic = publicOrigin !== undefined && host === publicOrigin.host;
      if (!host || (!allowedHosts.includes(host) && !isPublic) || url.host !== host) return json({ error: "Untrusted host" }, 403);
      // TLS terminates at the proxy. Its external origin comes only from explicit
      // configuration, never caller-controlled Forwarded / X-Forwarded-* headers.
      const expectedOrigin = isPublic ? publicOrigin!.origin : url.origin;
      const origin = req.headers.get("origin");
      const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if ((origin !== null && origin !== expectedOrigin) || ((mutating || upgrade) && origin !== expectedOrigin) ||
          req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Same-origin request required" }, 403);
      // The public cookie cannot be planted by a sibling subdomain with Domain=.
      // Keep the existing name for local HTTP sessions, where Secure is unavailable.
      const cookieName = `${isPublic ? "__Host-" : ""}kaname_session_${server.port}`;
      const session = req.headers.get("cookie")?.split(";").map(s => s.trim())
        .find(s => s.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
      const cookie = (value: string, age: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${isPublic ? "; Secure" : ""}`;
      if (url.pathname === "/auth/session" && req.method === "GET") return json({ authenticated: auth.valid(session) });
      if (url.pathname === "/auth/login" && req.method === "POST") {
        if (!req.headers.get("content-type")?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
        if (now() - loginWindow >= 60_000) { failedLogins = 0; loginWindow = now(); }
        if (failedLogins >= 10) return json({ error: "Too many attempts; retry in a minute" }, 429);
        const body = await req.json().catch(() => null);
        const created = auth.login(body?.token);
        if (!created) { failedLogins++; return json({ error: "Invalid login token" }, 401); }
        failedLogins = 0;
        if (session) { auth.logout(session); disconnect(session); }
        return json({ ok: true }, 200, { "set-cookie": cookie(created, Math.ceil(auth.ttl / 1000)) });
      }
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        auth.logout(session);
        if (session) disconnect(session);
        return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
      }
      if (url.pathname.startsWith("/auth/")) return json({ error: "Not found" }, 404);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        if (!auth.valid(session)) return json({ error: "Authentication required" }, 401);
        const target = new URL(backend);
        target.pathname = url.pathname.slice(4) || "/";
        target.search = url.search;
        target.searchParams.delete("token");
        if (upgrade) {
          if (!/^\/terminals\/[^/]+\/ws$/.test(target.pathname)) return json({ error: "Not found" }, 404);
          target.protocol = "ws:";
          return server.upgrade(req, { data: { session: session!, upstreamUrl: target.href, pending: [] } })
            ? undefined : json({ error: "WebSocket upgrade failed" }, 426);
        }
        const headers = new Headers();
        for (const name of ["content-type", "accept", "last-event-id", "range"]) {
          const value = req.headers.get(name); if (value) headers.set(name, value);
        }
        headers.set("authorization", `Bearer ${options.backendToken}`);
        const controller = new AbortController();
        const abort = () => controller.abort();
        const untrack = track(session!, abort);
        const cleanup = () => { untrack(); req.signal.removeEventListener("abort", abort); };
        req.signal.addEventListener("abort", abort, { once: true });
        if (req.signal.aborted) abort();
        try {
          const upstream = await fetch(target, {
            method: req.method, headers, body: mutating ? req.body : undefined,
            signal: controller.signal, redirect: "manual",
          });
          const responseHeaders = new Headers(secureHeaders);
          for (const name of ["content-type", "content-disposition", "content-range", "accept-ranges", "content-security-policy"]) {
            const value = upstream.headers.get(name); if (value) responseHeaders.set(name, value);
          }
          if (!upstream.body) { cleanup(); return new Response(null, { status: upstream.status, headers: responseHeaders }); }
          const reader = upstream.body.getReader();
          const body = new ReadableStream({
            async pull(out) {
              try {
                const next = await reader.read();
                if (next.done) { cleanup(); out.close(); } else out.enqueue(next.value);
              } catch (error) {
                cleanup();
                if (controller.signal.aborted) {
                  try { out.close(); } catch { /* consumer already cancelled */ }
                } else out.error(error);
              }
            },
            async cancel() { abort(); cleanup(); await reader.cancel().catch(() => {}); },
          });
          return new Response(body, { status: upstream.status, headers: responseHeaders });
        } catch { cleanup(); return json({ error: "Service unavailable; reconnecting is safe" }, 502); }
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
      try {
        let relative = decodeURIComponent(url.pathname).slice(1);
        if (!relative) relative = "index.html";
        if (relative.includes("\\") || relative.split("/").some(p => p === ".." || p.startsWith("."))) return json({ error: "Not found" }, 404);
        const file = realpathSync(path.join(root, relative));
        if (!file.startsWith(root + path.sep) || !statSync(file).isFile()) return json({ error: "Not found" }, 404);
        if (relative === "index.html") {
          const nonce = randomBytes(16).toString("base64");
          const html = index.replace(/<head>/i, '<head><script>window.__KANAME_WEB__=true;</script>')
            .replace(/<script\b/g, `<script nonce="${nonce}"`);
          return new Response(req.method === "HEAD" ? null : html, { headers: {
            ...secureHeaders, "content-type": "text/html; charset=utf-8",
            "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
          } });
        }
        return new Response(req.method === "HEAD" ? null : Bun.file(file), { headers: secureHeaders });
      } catch { return json({ error: "Not found" }, 404); }
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const upstream = new BackendWebSocket(ws.data.upstreamUrl, { headers: { authorization: `Bearer ${options.backendToken}` } });
        ws.data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        const timeout = setTimeout(() => ws.close(1011, "Backend unavailable"), 10_000);
        const untrack = track(ws.data.session, () => ws.close(1008, "Session ended"));
        ws.data.cleanup = () => { clearTimeout(timeout); untrack(); upstream.close(); };
        upstream.onopen = () => { clearTimeout(timeout); for (const message of ws.data.pending) upstream.send(message); ws.data.pending = []; };
        upstream.onmessage = event => ws.send(event.data);
        upstream.onclose = () => ws.close(1000, "Terminal disconnected");
        upstream.onerror = () => ws.close(1011, "Terminal unavailable");
      },
      message(ws, message) {
        if (!auth.valid(ws.data.session)) { ws.close(1008, "Session ended"); return; }
        if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
        else if (ws.data.pending.reduce((size, item) => size + item.length, 0) + message.length <= 1024 * 1024) ws.data.pending.push(message);
        else ws.close(1009, "Buffer full");
      },
      close(ws) { ws.data.cleanup?.(); },
      maxPayloadLength: 1024 * 1024,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
    },
  });
  const expirySweep = setInterval(() => {
    for (const session of connections.keys()) if (!auth.valid(session)) disconnect(session);
  }, 1000);
  expirySweep.unref();
  const stop = server.stop.bind(server);
  server.stop = (force?: boolean) => {
    clearInterval(expirySweep);
    for (const session of connections.keys()) disconnect(session);
    auth.close();
    return stop(force);
  };
  return server;
}
