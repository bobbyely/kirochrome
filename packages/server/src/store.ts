import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  KcError,
  KcEvent,
  ProviderCheckResult,
  Room,
  RoomMessage,
  RoomParticipant,
  Schedule,
  ScheduleRun,
  SearchHit,
  SessionRecord,
  StartOptions,
} from "@kirochrome/shared";
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
      -- Adoption looks conversations up by the agent's own session id, to avoid
      -- two KiroChrome logs appending over one agent session.
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_session_id);

      -- Full-text index over what was actually said. Derived from the event
      -- log, so it can be dropped and rebuilt at any time.
      -- (No backticks in this string: it is a TypeScript template literal.)
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        body,
        session_id UNINDEXED,
        seq UNINDEXED
      );

      -- Pasted images. Kept out of the event payloads so replaying a
      -- conversation does not push megabytes of base64 over the socket; the
      -- event carries ids and the browser fetches them over HTTP.
      CREATE TABLE IF NOT EXISTS attachments (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        mime       TEXT NOT NULL,
        data       TEXT NOT NULL,   -- base64
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;

      -- Remembered picker choices, re-applied to each new session of a
      -- provider. Values only; the list of options always comes from the agent.
      CREATE TABLE IF NOT EXISTS provider_defaults (
        provider_id TEXT NOT NULL,
        config_id   TEXT NOT NULL,
        value       TEXT NOT NULL,   -- JSON, so booleans survive the round trip
        PRIMARY KEY (provider_id, config_id)
      ) WITHOUT ROWID;

      -- Prompts the server runs on a timer. Here rather than in config.json
      -- because the UI edits them.
      CREATE TABLE IF NOT EXISTS schedules (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        provider_id   TEXT NOT NULL,
        cwd           TEXT NOT NULL,
        prompt        TEXT NOT NULL,
        every_minutes INTEGER NOT NULL,
        at            TEXT,               -- "HH:MM" local, or NULL for the interval
        weekdays_only INTEGER NOT NULL DEFAULT 0,
        keep_runs     INTEGER NOT NULL DEFAULT 20,
        auto_approve  INTEGER NOT NULL DEFAULT 0,
        start         TEXT NOT NULL DEFAULT '{}',  -- StartOptions as JSON
        status        TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      -- One row per firing, including the ones that never became a
      -- conversation, so a schedule that keeps failing to start is visible.
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id          TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        session_id  TEXT,
        outcome     TEXT NOT NULL,
        error       TEXT,             -- KcError as JSON
        message     TEXT,
        unread      INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_runs_schedule ON schedule_runs(schedule_id, started_at DESC);

      -- Rooms: agents talking in turns. Participants are a JSON list; the
      -- room's transcript is its own append-only log, separate from each
      -- participant's session log, which holds the prompts it was actually sent.
      CREATE TABLE IF NOT EXISTS rooms (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        cwd                 TEXT NOT NULL,
        topic               TEXT NOT NULL,
        participants        TEXT NOT NULL,   -- JSON RoomParticipant[]
        max_turns_per_round INTEGER NOT NULL,
        pause_seconds       INTEGER NOT NULL,
        credit_cap          REAL,
        status              TEXT NOT NULL,
        credits_used        REAL NOT NULL DEFAULT 0,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_messages (
        id      TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        ts      INTEGER NOT NULL,
        speaker TEXT NOT NULL,
        name    TEXT NOT NULL,
        text    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_messages ON room_messages(room_id, seq);
    `);

    this.migrate();
    this.backfillSearch();
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
    if (!columns.includes("schedule_id")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN schedule_id TEXT`);
    }
    if (!columns.includes("room_id")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN room_id TEXT`);
    }
    const scheduleColumns = (this.db.prepare(`PRAGMA table_info(schedules)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (!scheduleColumns.includes("auto_approve")) {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0`);
    }
    if (!scheduleColumns.includes("at")) {
      this.db.exec(`
        ALTER TABLE schedules ADD COLUMN at TEXT;
        ALTER TABLE schedules ADD COLUMN weekdays_only INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE schedules ADD COLUMN keep_runs INTEGER NOT NULL DEFAULT 20;
      `);
    }
    if (!scheduleColumns.includes("start")) {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN start TEXT NOT NULL DEFAULT '{}'`);
    }
    const runColumns = (this.db.prepare(`PRAGMA table_info(schedule_runs)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (!runColumns.includes("unread")) {
      this.db.exec(`ALTER TABLE schedule_runs ADD COLUMN unread INTEGER NOT NULL DEFAULT 1`);
    }
  }

  // ---------- sessions ----------

  upsertSession(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_session_id, provider_id, provider_name, cwd, title, status, created_at, updated_at, title_locked, schedule_id, room_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_session_id = excluded.agent_session_id,
           title = excluded.title,
           status = excluded.status,
           updated_at = excluded.updated_at,
           title_locked = excluded.title_locked,
           schedule_id = excluded.schedule_id,
           room_id = excluded.room_id`,
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
        record.scheduleId ?? null,
        record.roomId ?? null,
      );
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | Record<string, string | number | null>
      | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * The conversation already holding an agent session, if there is one.
   *
   * Two KiroChrome conversations pointing at one agent session would both
   * append to it and disagree about its transcript, so adopting checks here
   * first and reopens the existing one instead.
   */
  sessionByAgentSessionId(agentSessionId: string): SessionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE agent_session_id = ? ORDER BY created_at LIMIT 1`)
      .get(agentSessionId) as Record<string, string | number | null> | undefined;
    return row ? toRecord(row) : null;
  }

  listSessions(limit = 100, includeArchived = false): SessionRecord[] {
    const sql = includeArchived
      ? `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`
      : `SELECT * FROM sessions WHERE status != 'archived' ORDER BY updated_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(limit) as Array<Record<string, string | number | null>>;
    return rows.map(toRecord);
  }

  /**
   * Hides a conversation without touching its log. `events` is append-only, so
   * archiving is a status change and nothing else — it is always reversible.
   */
  setArchived(id: string, archived: boolean): void {
    this.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? "archived" : "active", Date.now(), id);
  }

  // ---------- schedules ----------

  upsertSchedule(schedule: Schedule): void {
    this.db
      .prepare(
        `INSERT INTO schedules (id, name, provider_id, cwd, prompt, every_minutes, at, weekdays_only, keep_runs, auto_approve, start, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, provider_id = excluded.provider_id, cwd = excluded.cwd,
           prompt = excluded.prompt, every_minutes = excluded.every_minutes, at = excluded.at,
           weekdays_only = excluded.weekdays_only, keep_runs = excluded.keep_runs,
           auto_approve = excluded.auto_approve, start = excluded.start, status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.providerId,
        schedule.cwd,
        schedule.prompt,
        schedule.everyMinutes,
        schedule.at,
        schedule.weekdaysOnly ? 1 : 0,
        schedule.keepRuns,
        schedule.autoApprove ? 1 : 0,
        JSON.stringify(schedule.start),
        schedule.status,
        schedule.createdAt,
        schedule.updatedAt,
      );
  }

  getSchedule(id: string): Schedule | null {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as
      | Record<string, string | number | null>
      | undefined;
    return row ? toSchedule(row) : null;
  }

  listSchedules(): Schedule[] {
    const rows = this.db.prepare(`SELECT * FROM schedules ORDER BY created_at`).all() as Array<
      Record<string, string | number | null>
    >;
    return rows.map(toSchedule);
  }

  /** Removes the schedule and its run history. Its conversations stay. */
  deleteSchedule(id: string): void {
    this.db.prepare(`DELETE FROM schedule_runs WHERE schedule_id = ?`).run(id);
    this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  }

  upsertRun(run: ScheduleRun): void {
    this.db
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, started_at, ended_at, session_id, outcome, error, message, unread)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at, session_id = excluded.session_id,
           outcome = excluded.outcome, error = excluded.error, message = excluded.message,
           unread = excluded.unread`,
      )
      .run(
        run.id,
        run.scheduleId,
        run.startedAt,
        run.endedAt,
        run.sessionId,
        run.outcome,
        run.error ? JSON.stringify(run.error) : null,
        run.message,
        run.unread ? 1 : 0,
      );
  }

  listRuns(scheduleId: string, limit = 10): ScheduleRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(scheduleId, limit) as Array<Record<string, string | number | null>>;
    return rows.map(toRun);
  }

  /** Opening a run's conversation is what reads it. */
  markRunRead(sessionId: string): void {
    this.db.prepare(`UPDATE schedule_runs SET unread = 0 WHERE session_id = ?`).run(sessionId);
  }

  /**
   * Runs beyond the newest `keep` for a schedule. Their rows stay — the
   * history page is the point of them — but their conversations can go.
   */
  runsBeyond(scheduleId: string, keep: number): ScheduleRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?`)
      .all(scheduleId, keep) as Array<Record<string, string | number | null>>;
    return rows.map(toRun);
  }

  /** Most recent firing per schedule, attempted or not — what the next one is counted from. */
  lastRunStartedAt(scheduleId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(started_at) AS at FROM schedule_runs WHERE schedule_id = ?`)
      .get(scheduleId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  /**
   * Runs the previous server left mid-flight. Their agents died with it, so
   * they are over — but nothing else will ever close them.
   */
  failOrphanRuns(error: KcError): number {
    const result = this.db
      .prepare(`UPDATE schedule_runs SET outcome = 'failed', ended_at = ?, error = ? WHERE outcome = 'running'`)
      .run(Date.now(), JSON.stringify(error));
    return Number(result.changes);
  }

  // ---------- rooms ----------

  upsertRoom(room: Room): void {
    this.db
      .prepare(
        `INSERT INTO rooms (id, name, cwd, topic, participants, max_turns_per_round, pause_seconds, credit_cap, status, credits_used, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, cwd = excluded.cwd, topic = excluded.topic,
           participants = excluded.participants, max_turns_per_round = excluded.max_turns_per_round,
           pause_seconds = excluded.pause_seconds, credit_cap = excluded.credit_cap,
           status = excluded.status, credits_used = excluded.credits_used, updated_at = excluded.updated_at`,
      )
      .run(
        room.id,
        room.name,
        room.cwd,
        room.topic,
        JSON.stringify(room.participants),
        room.maxTurnsPerRound,
        room.pauseSeconds,
        room.creditCap,
        room.status,
        room.creditsUsed,
        room.createdAt,
        room.updatedAt,
      );
  }

  getRoom(id: string): Room | null {
    const row = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as
      | Record<string, string | number | null>
      | undefined;
    return row ? toRoom(row) : null;
  }

  listRooms(): Room[] {
    const rows = this.db.prepare(`SELECT * FROM rooms ORDER BY updated_at DESC`).all() as Array<
      Record<string, string | number | null>
    >;
    return rows.map(toRoom);
  }

  /** Removes the room and its transcript. The participants' conversations stay. */
  deleteRoom(id: string): void {
    this.db.prepare(`DELETE FROM room_messages WHERE room_id = ?`).run(id);
    this.db.prepare(`DELETE FROM rooms WHERE id = ?`).run(id);
  }

  appendRoomMessage(message: RoomMessage): void {
    this.db
      .prepare(`INSERT INTO room_messages (id, room_id, seq, ts, speaker, name, text) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, message.roomId, message.seq, message.ts, message.speaker, message.name, message.text);
  }

  roomMessages(roomId: string, sinceSeq = 0): RoomMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM room_messages WHERE room_id = ? AND seq > ? ORDER BY seq`)
      .all(roomId, sinceSeq) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row["id"]),
      roomId: String(row["room_id"]),
      seq: Number(row["seq"]),
      ts: Number(row["ts"]),
      speaker: String(row["speaker"]),
      name: String(row["name"]),
      text: String(row["text"]),
    }));
  }

  lastRoomSeq(roomId: string): number {
    const row = this.db.prepare(`SELECT MAX(seq) AS seq FROM room_messages WHERE room_id = ?`).get(roomId) as
      | { seq: number | null }
      | undefined;
    return row?.seq ?? 0;
  }

  // ---------- attachments ----------

  addAttachment(id: string, sessionId: string, mime: string, base64: string): void {
    this.db
      .prepare(`INSERT INTO attachments (id, session_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, sessionId, mime, base64, Date.now());
  }

  attachment(id: string): { mime: string; data: string } | null {
    const row = this.db.prepare(`SELECT mime, data FROM attachments WHERE id = ?`).get(id) as
      | { mime: string; data: string }
      | undefined;
    return row ?? null;
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

    const body = searchableText(event);
    if (body) {
      this.db
        .prepare(`INSERT INTO events_fts (body, session_id, seq) VALUES (?, ?, ?)`)
        .run(body, sessionId, event.seq);
    }
  }

  /** Builds the index from the log when it is missing — after an upgrade, say. */
  private backfillSearch(): void {
    const indexed = this.db.prepare(`SELECT count(*) AS n FROM events_fts`).get() as { n: number };
    if (indexed.n > 0) return;

    const rows = this.db
      .prepare(`SELECT session_id, seq, payload FROM events WHERE type IN ('user_message','agent_text')`)
      .all() as Array<{ session_id: string; seq: number; payload: string }>;
    if (rows.length === 0) return;

    const insert = this.db.prepare(`INSERT INTO events_fts (body, session_id, seq) VALUES (?, ?, ?)`);
    for (const row of rows) {
      try {
        const body = searchableText(JSON.parse(row.payload) as KcEvent);
        if (body) insert.run(body, row.session_id, row.seq);
      } catch {
        // A single unreadable row must not stop the server starting.
      }
    }
    console.log(`[search] indexed ${rows.length} existing message(s)`);
  }

  /**
   * Full-text search across every conversation.
   *
   * Returns the best-matching snippet per session rather than every hit, which
   * is what a conversation list wants.
   */
  searchSessions(query: string, limit = 30): SearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];

    const rows = this.db
      .prepare(
        `SELECT f.session_id AS sessionId, f.seq AS seq,
                snippet(events_fts, 0, '\u0002', '\u0003', '…', 12) AS snippet,
                s.title AS title, s.provider_name AS providerName, s.status AS status
         FROM events_fts f
         JOIN sessions s ON s.id = f.session_id
         WHERE events_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit * 4) as Array<Record<string, string | number | null>>;

    // One hit per conversation: a list wants the best snippet, not every match.
    const best = new Map<string, SearchHit>();
    for (const row of rows) {
      const sessionId = String(row["sessionId"]);
      if (!best.has(sessionId)) {
        best.set(sessionId, {
          sessionId,
          seq: Number(row["seq"]),
          snippet: String(row["snippet"] ?? ""),
          title: (row["title"] as string | null) ?? null,
          providerName: String(row["providerName"] ?? ""),
        });
      }
      if (best.size >= limit) break;
    }
    return [...best.values()];
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

function toRoom(row: Record<string, string | number | null>): Room {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    cwd: String(row["cwd"]),
    topic: String(row["topic"]),
    participants: JSON.parse(String(row["participants"])) as RoomParticipant[],
    maxTurnsPerRound: Number(row["max_turns_per_round"]),
    pauseSeconds: Number(row["pause_seconds"]),
    creditCap: (row["credit_cap"] as number | null) ?? null,
    status: String(row["status"]) as Room["status"],
    creditsUsed: Number(row["credits_used"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function toSchedule(row: Record<string, string | number | null>): Schedule {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    providerId: String(row["provider_id"]),
    cwd: String(row["cwd"]),
    prompt: String(row["prompt"]),
    everyMinutes: Number(row["every_minutes"]),
    at: (row["at"] as string | null) ?? null,
    weekdaysOnly: Boolean(row["weekdays_only"]),
    keepRuns: Number(row["keep_runs"]),
    autoApprove: Boolean(row["auto_approve"]),
    start: JSON.parse(String(row["start"] ?? "{}")) as StartOptions,
    status: String(row["status"]) as Schedule["status"],
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function toRun(row: Record<string, string | number | null>): ScheduleRun {
  const error = row["error"];
  return {
    id: String(row["id"]),
    scheduleId: String(row["schedule_id"]),
    startedAt: Number(row["started_at"]),
    endedAt: (row["ended_at"] as number | null) ?? null,
    sessionId: (row["session_id"] as string | null) ?? null,
    outcome: String(row["outcome"]) as ScheduleRun["outcome"],
    error: typeof error === "string" ? (JSON.parse(error) as KcError) : null,
    message: (row["message"] as string | null) ?? null,
    unread: Boolean(row["unread"]),
  };
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
    scheduleId: (row["schedule_id"] as string | null) ?? null,
    roomId: (row["room_id"] as string | null) ?? null,
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

/** Only what a person actually said or was told is worth indexing. */
function searchableText(event: KcEvent): string | null {
  if (event.type === "user_message" || event.type === "agent_text") return event.text;
  return null;
}

/**
 * Turns a plain search box into a safe FTS5 query.
 *
 * FTS5 MATCH is a language, so raw input like `foo(` or `AND` is a syntax
 * error rather than a search. Every term is quoted and ANDed, which makes any
 * input legal and behaves the way a search box is expected to.
 */
function toMatchQuery(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.length > 0 ? terms.join(" AND ") : null;
}
