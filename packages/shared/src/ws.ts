import type { KcError } from "./errors.js";
import type { KcEvent, SessionSummary } from "./events.js";

/** Browser → server. */
export type ClientMessage =
  | { type: "open"; providerId: string }
  | { type: "subscribe"; sessionId: string; sinceSeq: number }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "cancel"; sessionId: string };

/** Server → browser. */
export type ServerMessage =
  | { type: "session_opened"; session: SessionSummary }
  /** A batch of log events at or after the requested seq. */
  | { type: "events"; sessionId: string; events: KcEvent[] }
  | { type: "session_state"; session: SessionSummary }
  | { type: "error"; error: KcError; sessionId?: string };
