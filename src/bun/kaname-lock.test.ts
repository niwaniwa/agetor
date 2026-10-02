import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireKanameLock } from "./kaname-lock.ts";

test("data directory lock refuses a second owner and allows one after release", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kaname-lock-"));
  const owner = await acquireKanameLock(dir);
  try {
    await expect(acquireKanameLock(dir)).rejects.toThrow("already owns");
    const other = await acquireKanameLock(mkdtempSync(path.join(tmpdir(), "kaname-lock-other-")));
    await other.release();
  } finally {
    await owner.release();
  }
  expect(await owner.exited).toBe(0);
  const replacement = await acquireKanameLock(dir);
  await replacement.release();
  await replacement.release();
});

test("a service crash releases ownership without a stale PID cleanup race", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kaname-lock-crash-"));
  const modulePath = path.join(import.meta.dir, "kaname-lock.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    import { acquireKanameLock } from ${JSON.stringify(modulePath)};
    await acquireKanameLock(${JSON.stringify(dir)});
    console.log("ready");
    setInterval(() => {}, 1000);
  `], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    await expect(acquireKanameLock(dir)).rejects.toThrow("already owns");
    child.kill("SIGKILL");
    await child.exited;
    let replacement: Awaited<ReturnType<typeof acquireKanameLock>> | null = null;
    for (let i = 0; i < 50 && !replacement; i++) {
      try { replacement = await acquireKanameLock(dir); } catch { await Bun.sleep(20); }
    }
    expect(replacement).not.toBeNull();
    await replacement?.release();
  } finally {
    child.kill();
    await reader.cancel();
  }
});
