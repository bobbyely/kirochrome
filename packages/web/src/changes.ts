import type { KcEvent } from "@kirochrome/shared";
// `.ts`, not `.js`: the unit suite runs this file under Node's type stripping,
// which does not rewrite `.js` specifiers, so a pure module the tests import
// has to name its siblings by their real extension. Vite resolves either.
import { countChanges, lineDiff } from "./diff.ts";
import { toolContent, type ToolDiff } from "./timeline.ts";

/** One file, as the agent reports having changed it this conversation. */
export interface FileChange {
  path: string;
  /** The file before the first reported edit and after the last: the net diff. */
  net: ToolDiff;
  /** Reported edits to this path, in order. */
  edits: number;
  /** Lines added and removed across the net diff, or null when it is too large to diff. */
  added: number | null;
  removed: number | null;
  /** The seq of the last edit, for "most recent first". */
  lastSeq: number;
}

/**
 * Every file the agent has touched this conversation, folded from the diffs
 * its tool calls reported.
 *
 * Reported diffs only, not the working tree: this needs no filesystem access
 * and stays honest about what the agent *claims* it did, which is the question
 * the pane answers. It also survives a restart, because the diffs are in the
 * log. The tree can disagree — a later hand edit, a git checkout — and that is
 * the Files tab's job, not this one's.
 */
export function collectChanges(events: readonly KcEvent[]): FileChange[] {
  // Same fold as the timeline: later updates to a call supersede earlier ones.
  const calls = new Map<string, { seq: number; details: unknown[] }>();
  for (const event of events) {
    if (event.type === "tool_call") {
      calls.set(event.toolCallId, { seq: event.seq, details: [event.raw] });
    } else if (event.type === "tool_call_update") {
      const call = calls.get(event.toolCallId);
      if (call) {
        call.details.push(event.raw);
        call.seq = event.seq;
      }
    }
  }

  const byPath = new Map<string, FileChange>();
  for (const call of [...calls.values()].sort((a, b) => a.seq - b.seq)) {
    for (const diff of toolContent(call.details).diffs) {
      if (!diff.path) continue;
      const existing = byPath.get(diff.path);
      if (existing) {
        existing.net = { path: diff.path, oldText: existing.net.oldText, newText: diff.newText };
        existing.edits += 1;
        existing.lastSeq = call.seq;
      } else {
        byPath.set(diff.path, { path: diff.path, net: diff, edits: 1, added: null, removed: null, lastSeq: call.seq });
      }
    }
  }

  const changes = [...byPath.values()];
  for (const change of changes) {
    const lines = lineDiff(change.net.oldText, change.net.newText);
    if (!lines) continue;
    const { added, removed } = countChanges(lines);
    change.added = added;
    change.removed = removed;
  }
  return changes.sort((a, b) => b.lastSeq - a.lastSeq);
}
