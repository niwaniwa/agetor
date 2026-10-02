import { homedir } from "node:os";
import path from "node:path";
import { loadPrivateToken } from "./web-auth.ts";
import { parsePublicOrigin, startWebServer } from "./web-server.ts";
import { acquireKanameLock } from "./kaname-lock.ts";
import { readCoreCreds, probeLiveCore } from "./core-creds.ts";

// Set before importing the existing core: db/api-config read env at module load.
const publicOrigin = parsePublicOrigin(process.env.KANAME_PUBLIC_ORIGIN)?.origin;
const dataDir = process.env.AGETOR_DATA_DIR ?? path.join(homedir(), ".kaname");
const ownership = await acquireKanameLock(dataDir);
void ownership.exited.then(() => {
  console.error("[kaname] Lost service ownership; stopping before further state changes");
  process.exit(1);
});
const existingCore = readCoreCreds(dataDir);
if (existingCore && await probeLiveCore(existingCore)) {
  throw new Error(`An Agetor core already uses ${dataDir}; stop it before starting KANAME`);
}
process.env.AGETOR_DATA_DIR = dataDir;
process.env.AGETOR_HEADLESS = "1";
process.env.AGETOR_API_TOKEN = loadPrivateToken(path.join(dataDir, "core-api-token"));
const port = Number(process.env.KANAME_WEB_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid KANAME_WEB_PORT");
const { runDaemon } = await import("./headless.ts");
const core = await runDaemon({ persistent: true });
try {
  const web = startWebServer({
    port, dataDir, publicOrigin,
    staticDir: process.env.KANAME_STATIC_DIR ?? path.resolve(import.meta.dir, "../../dist"),
    backendUrl: `http://127.0.0.1:${core.port}`,
    backendToken: process.env.AGETOR_API_TOKEN,
  });
  console.log(`[kaname] Browser: http://127.0.0.1:${web.port}`);
  if (publicOrigin) console.log(`[kaname] Public browser (reverse proxy required): ${publicOrigin}`);
  console.log(`[kaname] Login token file: ${path.join(dataDir, "web-login-token")}`);
} catch (error) {
  core.stop(true);
  console.error(`[kaname] ${error instanceof Error ? error.message : error}. Build the UI with bun run build:web.`);
  process.exit(1);
}
