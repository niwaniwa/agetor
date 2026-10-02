import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Separate credentials for the browser login and the CLI hooks. Never ship either in HTML. */
export function loadPrivateToken(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, randomBytes(32).toString("hex") + "\n"); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Not a regular credential file: ${file}`);
    fchmodSync(fd, 0o600);
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Invalid credential file: ${file}`);
    return token;
  } finally { closeSync(fd); }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Hash-only, durable sessions: a service restart preserves login; logout revokes it. */
export class WebAuth {
  private readonly db: Database;
  private readonly token: string;
  private readonly generation: string;
  readonly ttl: number;
  private readonly now: () => number;

  constructor(options: { dataDir: string; sessionTtlMs?: number; now?: () => number }) {
    this.token = loadPrivateToken(path.join(options.dataDir, "web-login-token"));
    this.generation = digest(this.token);
    this.ttl = options.sessionTtlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isFinite(this.ttl) || this.ttl <= 0) throw new Error("Invalid browser session TTL");
    this.now = options.now ?? Date.now;
    const dbPath = path.join(options.dataDir, "web-sessions.sqlite");
    const fd = openSync(dbPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    this.db = new Database(dbPath);
    this.db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, generation TEXT NOT NULL)");
    this.db.query("DELETE FROM sessions WHERE expires <= ? OR generation != ?").run(this.now(), this.generation);
  }

  login(token: unknown): string | null {
    if (typeof token !== "string" || token.length > 1024 ||
        !timingSafeEqual(Buffer.from(digest(token)), Buffer.from(this.generation))) return null;
    const session = randomBytes(32).toString("hex");
    this.db.query("DELETE FROM sessions WHERE expires <= ?").run(this.now());
    this.db.query("INSERT INTO sessions VALUES (?, ?, ?)").run(digest(session), this.now() + this.ttl, this.generation);
    return session;
  }

  valid(session: string | undefined): boolean {
    if (!session || !/^[a-f0-9]{64}$/.test(session)) return false;
    return this.db.query("SELECT 1 FROM sessions WHERE id = ? AND expires > ? AND generation = ?")
      .get(digest(session), this.now(), this.generation) != null;
  }

  logout(session: string | undefined): void {
    if (session) this.db.query("DELETE FROM sessions WHERE id = ?").run(digest(session));
  }
  close(): void { this.db.close(); }
}
