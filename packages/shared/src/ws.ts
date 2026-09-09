import type { KcError } from "./errors.js";
import type { KcEvent, SessionSummary } from "./events.js";

/** Browser → server. */
export type ClientMessage =
  | { type: "open"; providerId: string; cwd?: string }
  | { type: "subscribe"; sessionId: string; sinceSeq: number }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "cancel"; sessionId: string }
  | { type: "resume"; sessionId: string; sinceSeq: number }
  | { type: "list_sessions" }
  | { type: "list_workspaces" }
  | { type: "set_config_option"; sessionId: string; configId: string; value: string | boolean }
  | { type: "permission_response"; sessionId: string; requestId: string; optionId: string | null }
  | { type: "set_auto_approve"; sessionId: string; enabled: boolean }
  | { type: "rename_session"; sessionId: string; title: string };

/** Server → browser. */
export type ServerMessage =
  | { type: "session_opened"; session: SessionSummary }
  /** A batch of log events at or after the requested seq. */
  | { type: "events"; sessionId: string; events: KcEvent[] }
  | { type: "session_state"; session: SessionSummary }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "workspaces"; workspaces: string[]; current: string }
  | { type: "error"; error: KcError; sessionId?: string };
