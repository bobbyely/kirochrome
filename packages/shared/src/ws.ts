import type { KcError } from "./errors.js";
import type { CommandOption, KcEvent, SearchHit, SessionSummary } from "./events.js";

/** Browser → server. */
export type ClientMessage =
  | { type: "open"; providerId: string; cwd?: string }
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
