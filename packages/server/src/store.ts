import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { KcEvent, ProviderCheckResult, SessionRecord } from "@kirochrome/shared";
import { dataDir, dbPath } from "./paths.js";

/**
 * SQLite is built into Node 22 (`node:sqlite`) — no native module, no build
 * toolchain, identical on macOS and Linux. See docs/DESIGN.md.
 *
 * `events` is INSERT-only. Nothing here updates or deletes an event; `sessions`
 * is a derived index that could be rebuilt by replaying the log.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path = dbPath()) {
    mkdirSync(dataDir(), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS provider_checks (
        provider_id TEXT PRIMARY KEY,
        status      TEXT NOT NULL,
        stage       TEXT,
        error_code  TEXT,
        result      TEXT NOT NULL,
        checked_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id               TEXT PRIMARY KEY,
        agent_session_id TEXT,
        provider_id      TEXT NOT NULL,
        provider_name    TEXT NOT NULL,
        cwd              TEXT NOT NULL,
        title            TEXT,
        status           TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      -- seq is per-session and monotonic: it is what the wire protocol resumes
      -- from, so it is the key rather than a global rowid.
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        ts         INTEGER NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    `);
    // The database holds work conversations and source code. Keep it private.
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort; some filesystems (and Windows) will not have it.
    }
  }

  saveCheck(result: ProviderCheckResult): void {
    this.db
      .prepare(
        `INSERT INTO provider_checks (provider_id, status, stage, error_code, result, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           status = excluded.status, stage = excluded.stage,
           error_code = excluded.error_code, result = excluded.result,
           checked_at = excluded.checked_at`,
      )
      .run(
        result.providerId,
        result.status,
        result.stage,
        result.error?.code ?? null,
        JSON.stringify(result),
        result.checkedAt,
      );
  }

  lastCheck(providerId: string): ProviderCheckResult | null {
    const row = this.db
      .prepare(`SELECT result FROM provider_checks WHERE provider_id = ?`)
      .get(providerId) as { result?: string } | undefined;
    return row?.result ? (JSON.parse(row.result) as ProviderCheckResult) : null;
  }

  /**
   * Marks a provider as needing a re-check — used when a runtime failure
   * contradicts an earlier pass. Verified is a cached fact, not a guarantee.
   */
  markStale(providerId: string): void {
    this.db
      .prepare(`UPDATE provider_checks SET status = 'stale' WHERE provider_id = ?`)
      .run(providerId);
  }

  // ---------- sessions ----------

  upsertSession(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_session_id, provider_id, provider_name, cwd, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_session_id = excluded.agent_session_id,
           title = excluded.title,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.agentSessionId,
        record.providerId,
        record.providerName,
        record.cwd,
        record.title,
        record.status,
        record.createdAt,
        record.updatedAt,
      );
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | Record<string, string | number | null>
      | undefined;
    return row ? toRecord(row) : null;
  }

  listSessions(limit = 100): SessionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, string | number | null>>;
    return rows.map(toRecord);
  }

  // ---------- events (INSERT-only) ----------

  appendEvent(sessionId: string, event: KcEvent): void {
    this.db
      .prepare(`INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, event.seq, event.ts, event.type, JSON.stringify(event));
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(event.ts, sessionId);
  }

  eventsSince(sessionId: string, sinceSeq: number): KcEvent[] {
    const rows = this.db
      .prepare(`SELECT payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`)
      .all(sessionId, sinceSeq) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as KcEvent);
  }

  lastSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(seq) AS seq FROM events WHERE session_id = ?`)
      .get(sessionId) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Record<string, string | number | null>): SessionRecord {
  return {
    id: String(row["id"]),
    agentSessionId: (row["agent_session_id"] as string | null) ?? null,
    providerId: String(row["provider_id"]),
    providerName: String(row["provider_name"]),
    cwd: String(row["cwd"]),
    title: (row["title"] as string | null) ?? null,
    status: String(row["status"]) as SessionRecord["status"],
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}
