import type { KcError } from "./errors.js";
import type {
  CommandOption,
  ElicitationAction,
  ElicitationValue,
  KcEvent,
  SearchHit,
  SessionSummary,
} from "./events.js";

/** Browser → server. */
export type ClientMessage =
  | { type: "open"; providerId: string; cwd?: string }
  /**
   * Take over a conversation the agent already has, found via `session/list`.
   *
   * Answered with `session_opened`, exactly like `open` — from the browser's
   * point of view the difference is only where the transcript came from.
   */
  | { type: "adopt"; providerId: string; agentSessionId: string; cwd: string; title?: string }
  | { type: "subscribe"; sessionId: string; sinceSeq: number }
  | {
      type: "prompt";
      sessionId: string;
      text: string;
      /** Pasted images, base64 encoded. */
      images?: Array<{ mime: string; data: string }>;
    }
  | { type: "cancel"; sessionId: string }
  | { type: "resume"; sessionId: string; sinceSeq: number }
  | { type: "list_workspaces" }
  | { type: "set_config_option"; sessionId: string; configId: string; value: string | boolean }
  | { type: "permission_response"; sessionId: string; requestId: string; optionId: string | null }
  | {
      type: "elicitation_response";
      sessionId: string;
      requestId: string;
      action: ElicitationAction;
      /** Present only on `accept`; keyed by the field `key`s we sent. */
      content?: Record<string, ElicitationValue>;
    }
  | { type: "set_auto_approve"; sessionId: string; enabled: boolean }
  | { type: "rename_session"; sessionId: string; title: string }
  | { type: "unqueue"; sessionId: string; index: number }
  | { type: "edit_queued"; sessionId: string; index: number; text: string }
  | { type: "move_queued"; sessionId: string; from: number; to: number }
  | { type: "archive_session"; sessionId: string; archived: boolean }
  | { type: "search"; query: string }
  | { type: "command_options"; sessionId: string; command: string; partial: string }
  | { type: "list_sessions"; includeArchived?: boolean };

/** Server → browser. */
export type ServerMessage =
  | { type: "session_opened"; session: SessionSummary }
  /** A batch of log events at or after the requested seq. */
  | { type: "events"; sessionId: string; events: KcEvent[] }
  | { type: "session_state"; session: SessionSummary }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "search_results"; query: string; hits: SearchHit[] }
  | { type: "command_options_result"; command: string; partial: string; options: CommandOption[] }
  | { type: "workspaces"; workspaces: string[]; current: string }
  | { type: "error"; error: KcError; sessionId?: string };

/**
 * Validating the browser boundary.
 *
 * A frame arrives from a page we did not necessarily write, so `ClientMessage`
 * is a claim until something checks it. The guard lives here beside the type it
 * checks: a message shape and its validator drift the moment they are apart,
 * and both sides import from this file anyway.
 *
 * Hand-rolled rather than a schema library: the union is small and closed, and
 * a build-toolchain-free install is a portability requirement (AGENTS.md).
 *
 * Unknown *extra* properties are ignored. Rejecting them would make adding a
 * field to the client a breaking change for an older server, and they cannot
 * reach a handler that does not read them.
 */
export type Validated<T> =
  | { ok: true; value: T }
  /** What is wrong, phrased for whoever has to fix it. */
  | { ok: false; problem: string; cause?: string };

interface Field {
  /** Completes "must be …", so the message reads as a sentence. */
  expected: string;
  check: (value: unknown) => boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str: Field = { expected: "a string", check: (v) => typeof v === "string" };
// Rejects NaN and Infinity, which survive JSON.parse via `1e999` and would
// otherwise reach an array index or a queue position.
const num: Field = { expected: "a finite number", check: (v) => typeof v === "number" && Number.isFinite(v) };
const bool: Field = { expected: "a boolean", check: (v) => typeof v === "boolean" };
const strOrBool: Field = {
  expected: "a string or a boolean",
  check: (v) => typeof v === "string" || typeof v === "boolean",
};
const nullableStr: Field = {
  expected: "a string or null",
  check: (v) => v === null || typeof v === "string",
};
const elicitationAction: Field = {
  expected: "'accept', 'decline' or 'cancel'",
  check: (v) => v === "accept" || v === "decline" || v === "cancel",
};
const images: Field = {
  expected: "an array of { mime, data } objects",
  check: (v) =>
    Array.isArray(v) &&
    v.every((img) => isRecord(img) && typeof img.mime === "string" && typeof img.data === "string"),
};
const elicitationContent: Field = {
  expected: "an object of strings, numbers, booleans or string arrays",
  check: (v) =>
    isRecord(v) &&
    Object.values(v).every(
      (field) =>
        typeof field === "string" ||
        typeof field === "boolean" ||
        (typeof field === "number" && Number.isFinite(field)) ||
        (Array.isArray(field) && field.every((item) => typeof item === "string")),
    ),
};

interface MessageSpec {
  required?: Record<string, Field>;
  optional?: Record<string, Field>;
}

/**
 * One entry per member of the union. Keyed by `ClientMessage["type"]`, so
 * adding a message without a spec is a type error rather than a hole.
 */
const CLIENT_MESSAGE_SPECS: Record<ClientMessage["type"], MessageSpec> = {
  open: { required: { providerId: str }, optional: { cwd: str } },
  // `cwd` is required here, unlike `open`: it is the listed session's own
  // directory as the agent reported it, not a choice the user is making.
  adopt: { required: { providerId: str, agentSessionId: str, cwd: str }, optional: { title: str } },
  subscribe: { required: { sessionId: str, sinceSeq: num } },
  prompt: { required: { sessionId: str, text: str }, optional: { images } },
  cancel: { required: { sessionId: str } },
  resume: { required: { sessionId: str, sinceSeq: num } },
  list_workspaces: {},
  set_config_option: { required: { sessionId: str, configId: str, value: strOrBool } },
  permission_response: { required: { sessionId: str, requestId: str, optionId: nullableStr } },
  elicitation_response: {
    required: { sessionId: str, requestId: str, action: elicitationAction },
    optional: { content: elicitationContent },
  },
  set_auto_approve: { required: { sessionId: str, enabled: bool } },
  rename_session: { required: { sessionId: str, title: str } },
  unqueue: { required: { sessionId: str, index: num } },
  edit_queued: { required: { sessionId: str, index: num, text: str } },
  move_queued: { required: { sessionId: str, from: num, to: num } },
  archive_session: { required: { sessionId: str, archived: bool } },
  search: { required: { query: str } },
  command_options: { required: { sessionId: str, command: str, partial: str } },
  list_sessions: { optional: { includeArchived: bool } },
};

/** The closed set of accepted types, so a caller can enumerate them. */
export const CLIENT_MESSAGE_TYPES = Object.keys(CLIENT_MESSAGE_SPECS) as Array<ClientMessage["type"]>;

const isClientMessageType = (v: unknown): v is ClientMessage["type"] =>
  typeof v === "string" && Object.hasOwn(CLIENT_MESSAGE_SPECS, v);

/** Narrows an already-parsed value to a `ClientMessage`, or says why not. */
export function validateClientMessage(value: unknown): Validated<ClientMessage> {
  if (!isRecord(value)) {
    return { ok: false, problem: `a message must be a JSON object, not ${describe(value)}` };
  }
  if (value.type === undefined) return { ok: false, problem: "a message must have a 'type'" };
  if (!isClientMessageType(value.type)) {
    return { ok: false, problem: `unknown message type ${JSON.stringify(value.type)}` };
  }

  const spec = CLIENT_MESSAGE_SPECS[value.type];
  for (const [name, field] of Object.entries(spec.required ?? {})) {
    if (!(name in value)) return { ok: false, problem: `'${value.type}' is missing '${name}'` };
    if (!field.check(value[name])) {
      return { ok: false, problem: `'${value.type}': '${name}' must be ${field.expected}` };
    }
  }
  for (const [name, field] of Object.entries(spec.optional ?? {})) {
    // Absent and explicitly undefined both mean "not sent"; JSON only produces
    // the former, but a hand-built frame can produce the latter.
    if (value[name] === undefined) continue;
    if (!field.check(value[name])) {
      return { ok: false, problem: `'${value.type}': '${name}' must be ${field.expected}` };
    }
  }

  // Every field the handler reads has now been checked, so the cast is a
  // conclusion rather than an assumption.
  return { ok: true, value: value as ClientMessage };
}

/** Parses a raw frame and validates it, so both failures land at one door. */
export function parseClientMessage(raw: string): Validated<ClientMessage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      problem: "a message must be valid JSON",
      cause: err instanceof Error ? err.message : String(err),
    };
  }
  return validateClientMessage(parsed);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
