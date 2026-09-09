import type { KcEvent, PermissionOption } from "@kirochrome/shared";
import { updateCategory } from "@kirochrome/shared";

/**
 * Folds the event log into renderable rows.
 *
 * The important job here is collapsing a tool call and all of its subsequent
 * updates into ONE row keyed by `toolCallId`. A single agent action emits a
 * `tool_call` plus several `tool_call_update`s; rendering each as its own row
 * buries the conversation.
 *
 * A pure function of the log, so a replay produces identical output.
 */
export type Row =
  | { kind: "user"; seq: number; text: string }
  | { kind: "agent"; seq: number; text: string }
  | { kind: "thought"; seq: number; text: string }
  | { kind: "tool"; seq: number; toolCallId: string; title: string; toolKind: string; status: string; details: unknown[] }
  | { kind: "permission"; seq: number; requestId: string; title: string; options: PermissionOption[]; answeredWith: string | null }
  | { kind: "note"; seq: number; label: string }
  | { kind: "error"; seq: number; code: string; message: string; remediation?: string | undefined }
  | { kind: "divider"; seq: number };

export function buildRows(events: KcEvent[]): Row[] {
  const rows: Row[] = [];
  const toolRows = new Map<string, Extract<Row, { kind: "tool" }>>();
  const permissionRows = new Map<string, Extract<Row, { kind: "permission" }>>();

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        rows.push({ kind: "user", seq: event.seq, text: event.text });
        break;

      case "agent_text": {
        // Merge consecutive text so flush boundaries are invisible.
        const last = rows.at(-1);
        if (last?.kind === "agent") last.text += event.text;
        else rows.push({ kind: "agent", seq: event.seq, text: event.text });
        break;
      }

      case "tool_call": {
        const row: Extract<Row, { kind: "tool" }> = {
          kind: "tool",
          seq: event.seq,
          toolCallId: event.toolCallId,
          title: event.title,
          toolKind: event.kind,
          status: event.status,
          details: [event.raw],
        };
        toolRows.set(event.toolCallId, row);
        rows.push(row);
        break;
      }

      case "tool_call_update": {
        const row = toolRows.get(event.toolCallId);
        if (!row) break; // an update whose call predates the log we hold
        if (event.status) row.status = event.status;
        // A later update often carries the real title (the command actually run).
        const title = (event.raw as { title?: string })?.title;
        if (title) row.title = title;
        row.details.push(event.raw);
        break;
      }

      case "permission_request": {
        const row: Extract<Row, { kind: "permission" }> = {
          kind: "permission",
          seq: event.seq,
          requestId: event.requestId,
          title: event.title,
          options: event.options,
          answeredWith: null,
        };
        permissionRows.set(event.requestId, row);
        rows.push(row);
        break;
      }

      case "permission_resolved": {
        const row = permissionRows.get(event.requestId);
        if (row) row.answeredWith = event.optionId ?? event.outcome;
        break;
      }

      case "agent_update": {
        const u = event.update as { sessionUpdate?: string; content?: { text?: string } };
        if (updateCategory(u.sessionUpdate) === "state") break; // header state, not transcript
        if (u.sessionUpdate === "agent_thought_chunk") {
          const last = rows.at(-1);
          const text = u.content?.text ?? "";
          if (last?.kind === "thought") last.text += text;
          else rows.push({ kind: "thought", seq: event.seq, text });
          break;
        }
        rows.push({ kind: "note", seq: event.seq, label: u.sessionUpdate ?? "update" });
        break;
      }

      case "error":
        rows.push({
          kind: "error",
          seq: event.seq,
          code: event.error.code,
          message: event.error.message,
          remediation: event.error.remediation,
        });
        break;

      case "resumed":
        rows.push({ kind: "note", seq: event.seq, label: "Agent re-attached" });
        break;

      case "agent_exited":
        rows.push({
          kind: "note",
          seq: event.seq,
          label: `Agent exited (${event.signal ?? `code ${event.code}`})`,
        });
        break;

      case "turn_end":
        if (rows.length > 0) rows.push({ kind: "divider", seq: event.seq });
        break;

      // turn_start drives the busy indicator, not the transcript.
    }
  }
  return rows;
}

/** Best-effort one-line summary of what a tool call actually did. */
export function toolSubtitle(details: unknown[]): string | null {
  for (const detail of details) {
    const d = detail as { rawInput?: Record<string, unknown>; content?: unknown };
    const input = d?.rawInput;
    if (!input) continue;
    const candidate = input["command"] ?? input["file_path"] ?? input["path"] ?? input["pattern"];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}
