import type { KcError } from "./errors.js";

/**
 * The append-only event log.
 *
 * The server appends; the browser renders. `seq` is monotonic per session and
 * is the entire reconnect mechanism: a client says "I have up to N" and gets
 * everything after. Events are never mutated or deleted once appended.
 */
export interface KcEventBase {
  seq: number;
  ts: number;
}

export type KcEvent = KcEventBase &
  (
    | { type: "user_message"; text: string }
    /** Coalesced agent text. Deltas are buffered before append — never one event per token. */
    | { type: "agent_text"; text: string }
    /** Any non-text ACP session update, kept raw until phase 5 renders it properly. */
    | { type: "agent_update"; update: unknown }
    | { type: "turn_start" }
    | { type: "turn_end"; stopReason: string }
    | { type: "error"; error: KcError }
    | { type: "agent_exited"; code: number | null; signal: string | null }
  );

export type KcEventType = KcEvent["type"];

/**
 * A new event before the log assigns it `seq`/`ts`.
 *
 * Distributes over the union — a plain `Omit<KcEvent, ...>` would collapse to
 * only the keys every variant shares, losing `text`, `error` and friends.
 */
export type KcEventInput = KcEvent extends infer E
  ? E extends KcEventBase
    ? Omit<E, "seq" | "ts">
    : never
  : never;

export interface SessionSummary {
  id: string;
  providerId: string;
  providerName: string;
  cwd: string;
  /** True while a turn is in flight. */
  busy: boolean;
  lastSeq: number;
  title: string | null;
  /**
   * False for a session read back from disk with no agent attached: its
   * transcript is readable but it cannot be prompted until reopened.
   */
  live: boolean;
}

/**
 * ACP session updates split into two jobs: things that belong in the
 * transcript, and things that describe session state.
 *
 * Rendering every update as a transcript row buries the conversation under
 * `usage_update` noise. Both kinds are still appended to the log — the log
 * stays the source of truth — but only transcript updates become rows.
 */
const STATE_UPDATES = new Set([
  "usage_update",
  "session_info_update",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "compaction_update",
]);

export type UpdateCategory = "transcript" | "state";

/** Unknown updates default to `transcript`, so something new is noticed rather than hidden. */
export function updateCategory(sessionUpdate: string | undefined): UpdateCategory {
  return sessionUpdate && STATE_UPDATES.has(sessionUpdate) ? "state" : "transcript";
}

/** Context-window usage, as reported by `usage_update`. */
export interface SessionUsage {
  used: number;
  size: number;
  /** ACP requires both fields on Cost, so never assume a currency. */
  cost?: { amount: number; currency: string };
}

/** Reads the latest usage out of the event log. The browser derives state; it never stores it. */
export function latestUsage(events: KcEvent[]): SessionUsage | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "agent_update") continue;
    const u = event.update as {
      sessionUpdate?: string;
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
    };
    if (u.sessionUpdate !== "usage_update") continue;
    if (typeof u.used !== "number" || typeof u.size !== "number") continue;
    return { used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}) };
  }
  return null;
}

/** A persisted session row. `sessions` is a derived index over the event log. */
export interface SessionRecord {
  id: string;
  /** The agent's own session id, kept so `session/load` can re-hydrate it. */
  agentSessionId: string | null;
  providerId: string;
  providerName: string;
  cwd: string;
  title: string | null;
  status: "active" | "closed";
  createdAt: number;
  updatedAt: number;
}
