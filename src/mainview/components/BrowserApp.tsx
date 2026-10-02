import { useCallback, useEffect, useRef, useState } from "react";
import App from "../App";
import { AUTH_REQUIRED_EVENT, CONNECTION_EVENT, RECONNECTED_EVENT } from "@/lib/transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** The app (and all its polls/streams) mounts only after cookie authentication.
 * Tokens live only in the password field until login, never in storage/URLs. */
export function BrowserApp() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const generation = useRef(0);

  const checkSession = useCallback(async () => {
    const current = generation.current;
    try {
      const res = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error("Could not check the session. Retry when the service is available.");
      const session = await res.json() as { authenticated: boolean };
      if (generation.current !== current) return;
      setAuthenticated(session.authenticated === true);
      setError(null);
      return true;
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
      return false;
    }
  }, []);

  useEffect(() => {
    document.title = "KANAME";
    document.getElementById("splash")?.remove();
    void checkSession();
    const expired = () => {
      generation.current++;
      setAuthenticated(false);
      setToken("");
      setError("Your session has expired. Sign in again.");
    };
    const connection = (event: Event) => {
      const available = (event as CustomEvent<boolean>).detail;
      setConnected(available);
      // A successful reconnect must also clear the network error from the
      // failed session probe, without waiting for the 30-second poll.
      void checkSession();
    };
    const visible = () => { if (!document.hidden) void checkSession(); };
    const offline = () => setConnected(false);
    const online = () => { void checkSession().then((reachable) => { if (reachable) setConnected(true); }); };
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    window.addEventListener(CONNECTION_EVENT, connection);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    // A closed SSE on logout from another tab must eventually discard stale UI.
    const timer = setInterval(() => { if (!document.hidden) void checkSession(); }, 30_000);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
      window.removeEventListener(CONNECTION_EVENT, connection);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [checkSession]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    generation.current++;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(res.status === 401 ? "Invalid access token." : "Sign in failed. Try again.");
      generation.current++;
      setToken("");
      setAuthenticated(true);
      setConnected(true);
    } catch (e) {
      setError((e as Error).message);
    } finally { setPending(false); }
  };

  const logout = async () => {
    if (pending) return;
    generation.current++;
    setPending(true);
    try {
      const res = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new Error("Sign out failed. Try again.");
      generation.current++;
      setAuthenticated(false);
      setError(null);
      setToken("");
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };

  if (authenticated) return (
    <>
      <App onLogout={() => { void logout(); }} logoutPending={pending} />
      {(!connected || error) && (
        <div role="status" className="fixed bottom-3 left-1/2 z-[100] -translate-x-1/2 rounded-md border border-border bg-card px-4 py-2 text-sm shadow-lg">
          {error ?? "Connection lost. Reconnecting; running agents continue on the server."}
          <Button size="sm" variant="ghost" onClick={() => {
            void checkSession();
            window.dispatchEvent(new Event(RECONNECTED_EVENT));
          }}>Retry</Button>
        </div>
      )}
    </>
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <form onSubmit={login} className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-lg">
        <h1 className="text-xl font-semibold">KANAME</h1>
        {authenticated === null ? <p role="status">Checking session…</p> : <>
          <p className="text-sm text-muted-foreground">Sign in with the access token configured on your server.</p>
          <label htmlFor="kaname-access-token" className="block text-sm">Access token</label>
          <Input id="kaname-access-token" type="password" autoComplete="off" autoFocus required value={token} onChange={(e) => setToken(e.target.value)} />
          <Button type="submit" disabled={pending || !token}>{pending ? "Signing in…" : "Sign in"}</Button>
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {authenticated === null && error && <Button type="button" onClick={() => { void checkSession(); }}>Retry</Button>}
      </form>
    </main>
  );
}
