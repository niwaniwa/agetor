import { mkdirSync } from "node:fs";
import path from "node:path";

export interface KanameLock {
  /** A service must stop if its guardian exits unexpectedly. */
  exited: Promise<number>;
  release(): Promise<void>;
}

/**
 * Own a data directory before importing the database or recovering CLI runs.
 * Linux flock supplies atomic ownership without stale PID-file races. A tiny
 * guardian holds the advisory lock only while Bun's private stdin pipe stays
 * open; even SIGKILL of Bun closes that pipe and releases ownership. The lock
 * descriptor lives in flock, never in Bun or a detached tmux child.
 */
export async function acquireKanameLock(dataDir: string): Promise<KanameLock> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const flock = Bun.which("flock");
  if (!flock) throw new Error("KANAME requires Linux flock (util-linux) for single-service ownership");
  const proc = Bun.spawn([
    flock, "--exclusive", "--nonblock", "--conflict-exit-code", "73", "--close",
    path.join(dataDir, "kaname.lock"),
    "sh", "-c", "printf 'locked\\n'; cat >/dev/null",
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // Drain stderr immediately, including a failed exec after lock acquisition.
  const errorText = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  await reader.cancel();
  if (first.done || new TextDecoder().decode(first.value) !== "locked\n") {
    proc.stdin.end();
    const code = await proc.exited;
    const detail = (await errorText).trim();
    if (code === 73) throw new Error(`Another KANAME service already owns ${dataDir}`);
    throw new Error(`Cannot acquire KANAME service lock${detail ? `: ${detail}` : ` (exit ${code})`}`);
  }
  let released = false;
  return {
    exited: proc.exited,
    async release() {
      if (!released) {
        released = true;
        proc.stdin.end();
      }
      await proc.exited;
      await errorText;
    },
  };
}
