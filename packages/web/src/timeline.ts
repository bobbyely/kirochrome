import type {
  Attachment,
  ElicitationAction,
  ElicitationField,
  ElicitationValue,
  KcEvent,
  PermissionOption,
} from "@kirochrome/shared";
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
  | { kind: "user"; seq: number; text: string; attachments: Attachment[] }
  | { kind: "agent"; seq: number; text: string }
  | { kind: "thought"; seq: number; text: string }
  | { kind: "tool"; seq: number; toolCallId: string; title: string; toolKind: string; status: string; details: unknown[] }
  | { kind: "permission"; seq: number; requestId: string; title: string; options: PermissionOption[]; answeredWith: string | null }
  | {
      kind: "elicitation";
      seq: number;
      requestId: string;
      message: string;
      title: string | undefined;
      fields: ElicitationField[];
      /** Null while the question is still open. */
      answer: { action: ElicitationAction; content?: Record<string, ElicitationValue> } | null;
    }
  | { kind: "note"; seq: number; label: string }
  /** Where the agent replaced conversation history with a summary. */
  | {
      kind: "compaction";
      seq: number;
      compactionId: string;
      status: string;
      summary: string;
      error: string | null;
    }
  /** Consecutive tool calls and thinking, folded into one collapsible run. */
  | { kind: "work"; seq: number; children: Row[]; tools: number; thoughts: number; active: boolean }
  | { kind: "error"; seq: number; code: string; message: string; remediation?: string | undefined }
  | { kind: "divider"; seq: number };

/**
 * Folds runs of consecutive tool calls and thinking into a single `work` row.
 *
 * A turn that reads four files and runs two commands is six rows of machinery
 * around one sentence of answer. Grouping keeps the conversation legible while
 * leaving every card one click away.
 *
 * A lone item is left alone — wrapping one tool call in a group is pure noise.
 */
function groupWork(rows: Row[]): Row[] {
  const out: Row[] = [];
  let run: Row[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]!);
    } else {
      const tools = run.filter((r) => r.kind === "tool");
      out.push({
        kind: "work",
        seq: run[0]!.seq,
        children: run,
        tools: tools.length,
        thoughts: run.filter((r) => r.kind === "thought").length,
        active: tools.some((r) => r.kind === "tool" && r.status !== "completed" && r.status !== "failed"),
      });
    }
    run = [];
  };

  for (const row of rows) {
    if (row.kind === "tool" || row.kind === "thought") run.push(row);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}

/**
 * Applies one `compaction_update`, creating the row or patching it in place.
 *
 * ACP gives `summary` and `error` patch semantics: omitting a field leaves the
 * stored value alone, `null` clears it, and a value replaces it. Treating an
 * omission as "clear" would wipe the summary on the very update that reports
 * the compaction finished.
 */
function foldCompaction(
  seq: number,
  update: unknown,
  rows: Row[],
  index: Map<string, Extract<Row, { kind: "compaction" }>>,
): void {
  const u = update as {
    compactionId?: string;
    status?: string;
    summary?: Array<{ text?: string }> | null;
    error?: string | null;
  };
  if (!u.compactionId) return;

  let row = index.get(u.compactionId);
  if (!row) {
    row = {
      kind: "compaction",
      seq,
      compactionId: u.compactionId,
      status: u.status ?? "in_progress",
      summary: "",
      error: null,
    };
    index.set(u.compactionId, row);
    rows.push(row);
  } else if (u.status) {
    row.status = u.status;
  }

  // `summary: []` clears, same as null — the spec spells both out.
  if (u.summary === null) row.summary = "";
  else if (Array.isArray(u.summary)) {
    row.summary = u.summary.map((block) => block?.text ?? "").join("");
  }
  if (u.error !== undefined) row.error = u.error;
}

export function buildRows(events: KcEvent[]): Row[] {
  const rows: Row[] = [];
  const toolRows = new Map<string, Extract<Row, { kind: "tool" }>>();
  const permissionRows = new Map<string, Extract<Row, { kind: "permission" }>>();
  const elicitationRows = new Map<string, Extract<Row, { kind: "elicitation" }>>();
  const compactionRows = new Map<string, Extract<Row, { kind: "compaction" }>>();

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        rows.push({
          kind: "user",
          seq: event.seq,
          text: event.text,
          attachments: event.attachments ?? [],
        });
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

      case "elicitation_request": {
        const row: Extract<Row, { kind: "elicitation" }> = {
          kind: "elicitation",
          seq: event.seq,
          requestId: event.requestId,
          message: event.message,
          title: event.title,
          fields: event.fields,
          answer: null,
        };
        elicitationRows.set(event.requestId, row);
        rows.push(row);
        break;
      }

      case "elicitation_resolved": {
        const row = elicitationRows.get(event.requestId);
        if (row) row.answer = { action: event.action, content: event.content };
        break;
      }

      case "agent_update": {
        const u = event.update as { sessionUpdate?: string; content?: { text?: string } };

        // Compaction is upserted by id: the first update fixes its place in the
        // timeline and later ones patch it there, rather than adding rows.
        if (u.sessionUpdate === "compaction_update") {
          foldCompaction(event.seq, event.update, rows, compactionRows);
          break;
        }
        if (u.sessionUpdate === "compaction_summary_chunk") {
          const c = event.update as { compactionId?: string; content?: { text?: string } };
          const row = c.compactionId ? compactionRows.get(c.compactionId) : undefined;
          if (row) row.summary += c.content?.text ?? "";
          break;
        }

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
  return groupWork(rows);
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

export interface ToolDiff {
  path: string;
  oldText: string;
  newText: string;
}

export interface ToolContent {
  diffs: ToolDiff[];
  texts: string[];
  terminalIds: string[];
}

/**
 * Pulls the renderable parts out of a tool call's updates.
 *
 * ACP's `ToolCallContent` has three shapes — `content`, `diff` and `terminal` —
 * and later updates supersede earlier ones for the same call, so the last
 * update carrying content wins rather than concatenating every revision.
 */
export function toolContent(details: unknown[]): ToolContent {
  const result: ToolContent = { diffs: [], texts: [], terminalIds: [] };

  for (let i = details.length - 1; i >= 0; i--) {
    const content = (details[i] as { content?: unknown })?.content;
    if (!Array.isArray(content) || content.length === 0) continue;

    for (const entry of content as Array<Record<string, unknown>>) {
      if (entry["type"] === "diff") {
        const path = typeof entry["path"] === "string" ? entry["path"] : "";
        result.diffs.push({
          path,
          oldText: typeof entry["oldText"] === "string" ? entry["oldText"] : "",
          newText: typeof entry["newText"] === "string" ? entry["newText"] : "",
        });
      } else if (entry["type"] === "terminal") {
        const id = entry["terminalId"];
        if (typeof id === "string") result.terminalIds.push(id);
      } else {
        const inner = entry["content"] as { type?: string; text?: string } | undefined;
        if (inner?.type === "text" && inner.text) result.texts.push(inner.text);
      }
    }
    break; // the latest update with content is authoritative
  }
  return result;
}

/** Language hint for highlighting, from a file path. */
export function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", sh: "bash", bash: "bash",
    json: "json", css: "css", html: "xml", md: "markdown", yml: "yaml", yaml: "yaml", sql: "sql",
  };
  return map[ext] ?? "";
}
