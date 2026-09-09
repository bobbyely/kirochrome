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
    /** `attachments` holds ids, not bytes — see the attachments table. */
    | { type: "user_message"; text: string; attachments?: Attachment[] }
    /** Coalesced agent text. Deltas are buffered before append — never one event per token. */
    | { type: "agent_text"; text: string }
    /** Any non-text ACP session update we do not model explicitly. */
    | { type: "agent_update"; update: unknown }
    | { type: "tool_call"; toolCallId: string; title: string; kind: string; status: string; raw: unknown }
    | { type: "tool_call_update"; toolCallId: string; status?: string; raw: unknown }
    /** The agent is asking to do something; the UI must answer. */
    | { type: "permission_request"; requestId: string; title: string; options: PermissionOption[] }
    | { type: "permission_resolved"; requestId: string; optionId: string | null; outcome: string }
    | { type: "turn_start" }
    /** Marks where an agent was re-attached to a restored conversation. */
    | { type: "resumed" }
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
  /** Selectable settings the agent advertises. Empty when it offers none. */
  configOptions: ConfigOption[];
  autoApprove: boolean;
  /** A permission prompt is open: the agent is blocked until the user answers. */
  awaitingInput: boolean;
  /** Messages typed during a turn, waiting their turn to be sent. */
  queued: string[];
  archived: boolean;
  /** Whether the agent said it accepts images in a prompt. */
  supportsImages: boolean;
  /** Commands the agent advertises, for the composer's picker. */
  commands: SlashCommand[];
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

export interface Attachment {
  id: string;
  mime: string;
}

/**
 * A command the agent advertises via `available_commands_update`.
 *
 * Standard ACP: commands are executed by sending their text as an ordinary
 * prompt, not through a dedicated method — so nothing agent-specific is needed
 * to support them.
 */
export interface SlashCommand {
  name: string;
  description: string;
  /** Present when the command takes an argument; `hint` describes it. */
  input?: { hint?: string } | null;
}

/** One suggestion from an agent that supports argument completion. */
export interface CommandOption {
  value: string;
  label: string;
  description?: string;
  /** True when this is the value currently in effect. */
  current?: boolean;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /** ACP kinds: allow_once, allow_always, reject_once, reject_always. */
  kind: string;
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
  status: "active" | "closed" | "archived";
  /** True once the user has renamed it, which stops the agent renaming it back. */
  titleLocked: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * One selectable setting an agent exposes for a session — a model, a mode, a
 * reasoning level. Normalised from whichever dialect the agent speaks
 * (`configOptions`, or the older `availableModels` / `availableModes`) so the
 * UI renders one shape and never hardcodes a list.
 */
export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  /** e.g. "model", "mode", "thought_level". Used only for grouping and icons. */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options?: ConfigOptionValue[];
}

/** One conversation matching a search, with its best snippet. */
export interface SearchHit {
  sessionId: string;
  seq: number;
  /** Matches are wrapped in \u0002 … \u0003 so the UI can highlight them safely. */
  snippet: string;
  title: string | null;
  providerName: string;
}
