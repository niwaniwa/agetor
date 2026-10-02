/** Browser builds are identified by the web server before modules execute.
 * Desktop preload/hash credentials retain their existing transport. */
declare global {
  interface Window { __KANAME_WEB__?: boolean }
}

export const browserMode = typeof window !== "undefined" && window.__KANAME_WEB__ === true;
export const AUTH_REQUIRED_EVENT = "kaname:auth-required";
export const RECONNECTED_EVENT = "kaname:reconnected";
export const CONNECTION_EVENT = "kaname:connection";

export function createTransport(input: { browser: boolean; origin: string; port: string; token: string }) {
  const base = input.browser ? "/api" : `http://127.0.0.1:${input.port}`;
  const headers: Record<string, string> = input.browser ? {} : { authorization: `Bearer ${input.token}` };
  return {
    base,
    headers,
    /** Cookies authenticate browser media, SSE and WS without URL secrets. */
    url(path: string): string {
      const url = input.browser ? new URL(`${base}${path}`, input.origin) : new URL(`${base}${path}`);
      if (!input.browser) url.searchParams.set("token", input.token);
      return url.toString();
    },
    socketUrl(path: string): string {
      const url = new URL(this.url(path));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    },
  };
}

export function reportUnauthorized(response: Response): void {
  if (browserMode && response.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}

/** Global stream availability is also the browser's reconnect signal. Task
 * streams retain their persisted replay and per-event deduplication. */
export function watchConnection(source: EventSource): void {
  if (!browserMode) return;
  let opened = false;
  source.onopen = () => {
    window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: true }));
    if (opened) window.dispatchEvent(new Event(RECONNECTED_EVENT));
    opened = true;
  };
  source.addEventListener("error", () => {
    window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: false }));
  });
}
