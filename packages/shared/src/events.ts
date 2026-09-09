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
}
