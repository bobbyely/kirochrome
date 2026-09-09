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

      -- Remembered picker choices, re-applied to each new session of a
      -- provider. Values only; the list of options always comes from the agent.
      CREATE TABLE IF NOT EXISTS provider_defaults (
        provider_id TEXT NOT NULL,
        config_id   TEXT NOT NULL,
        value       TEXT NOT NULL,   -- JSON, so booleans survive the round trip
        PRIMARY KEY (provider_id, config_id)
      ) WITHOUT ROWID;
    `);

    this.migrate();
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
      .prepare(`SELECT status, result FROM provider_checks WHERE provider_id = ?`)
      .get(providerId) as { status?: string; result?: string } | undefined;
    if (!row?.result) return null;

    const result = JSON.parse(row.result) as ProviderCheckResult;
    // The stored blob is the check as it ran; the column is the current
    // verdict, which markStale can move after the fact. The column wins.
    return { ...result, status: (row.status as ProviderCheckResult["status"]) ?? result.status };
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

  /**
   * Additive migrations for databases created by an earlier version.
   * Columns only ever get added, never dropped — the log is append-only and so,
   * in spirit, is its schema.
   */
  private migrate(): void {
    const columns = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (!columns.includes("title_locked")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0`);
    }
  }

  // ---------- sessions ----------

  upsertSession(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_session_id, provider_id, provider_name, cwd, title, status, created_at, updated_at, title_locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_session_id = excluded.agent_session_id,
           title = excluded.title,
           status = excluded.status,
           updated_at = excluded.updated_at,
           title_locked = excluded.title_locked`,
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
        record.titleLocked ? 1 : 0,
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

  // ---------- provider defaults ----------

  setProviderDefault(providerId: string, configId: string, value: string | boolean): void {
    this.db
      .prepare(
        `INSERT INTO provider_defaults (provider_id, config_id, value) VALUES (?, ?, ?)
         ON CONFLICT(provider_id, config_id) DO UPDATE SET value = excluded.value`,
      )
      .run(providerId, configId, JSON.stringify(value));
  }

  providerDefaults(providerId: string): Map<string, string | boolean> {
    const rows = this.db
      .prepare(`SELECT config_id, value FROM provider_defaults WHERE provider_id = ?`)
      .all(providerId) as Array<{ config_id: string; value: string }>;

    const defaults = new Map<string, string | boolean>();
    for (const row of rows) {
      try {
        defaults.set(row.config_id, JSON.parse(row.value) as string | boolean);
      } catch {
        // A malformed row should not stop a session from starting.
      }
    }
    return defaults;
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

  /**
   * Renames a conversation and locks the title, so the agent's own
   * `session_info_update` does not overwrite what the user chose.
   */
  renameSession(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, title_locked = 1, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), id);
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
    titleLocked: Boolean(row["title_locked"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}
