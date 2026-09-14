import { test } from "node:test";
import assert from "node:assert/strict";
import type { KcEvent } from "@kirochrome/shared";
import { collectChanges } from "../changes.ts";

let seq = 0;
const call = (id: string, diffs: Array<{ path: string; oldText: string; newText: string }>): KcEvent[] => [
  { seq: ++seq, ts: 0, type: "tool_call", toolCallId: id, title: "edit", kind: "edit", status: "in_progress", raw: {} },
  {
    seq: ++seq,
    ts: 0,
    type: "tool_call_update",
    toolCallId: id,
    status: "completed",
    raw: { content: diffs.map((d) => ({ type: "diff", ...d })) },
  },
];

test("folds repeated edits to one path into a net diff, most recent first", () => {
  const events = [
    ...call("a", [{ path: "src/x.ts", oldText: "one\n", newText: "one\ntwo\n" }]),
    ...call("b", [{ path: "README.md", oldText: "", newText: "# hi" }]),
    ...call("c", [{ path: "src/x.ts", oldText: "one\ntwo\n", newText: "two\nthree\n" }]),
  ];
  const changes = collectChanges(events);
  assert.deepEqual(
    changes.map((c) => [c.path, c.edits, c.added, c.removed]),
    [
      ["src/x.ts", 2, 2, 1],
      ["README.md", 1, 1, 0],
    ],
  );
  assert.equal(changes[0]?.net.oldText, "one\n", "net diff starts from the first old text");
  assert.equal(changes[0]?.net.newText, "two\nthree\n", "and ends at the last new text");
});

test("ignores tool calls that reported no diff, and updates for calls it never saw", () => {
  const events: KcEvent[] = [
    { seq: 1, ts: 0, type: "tool_call", toolCallId: "r", title: "read", kind: "read", status: "completed", raw: {} },
    { seq: 2, ts: 0, type: "tool_call_update", toolCallId: "ghost", raw: { content: [{ type: "diff", path: "a", oldText: "", newText: "x" }] } },
  ];
  assert.deepEqual(collectChanges(events), []);
});
