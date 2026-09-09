import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportFilename, toMarkdown } from "../dist/export.js";

const record = {
  id: "s1", agentSessionId: null, providerId: "p", providerName: "Kiro CLI",
  cwd: "/home/me/project", title: "Fix the parser", status: "active",
  createdAt: Date.UTC(2026, 0, 15), updatedAt: 0, titleLocked: false,
};

describe("toMarkdown", () => {
  it("renders a conversation with its header and both speakers", () => {
    const md = toMarkdown(record, [
      { seq: 1, ts: 0, type: "user_message", text: "why is this failing?" },
      { seq: 2, ts: 0, type: "agent_text", text: "Because of a typo." },
    ]);
    assert.match(md, /^# Fix the parser/);
    assert.match(md, /\*\*Agent:\*\* Kiro CLI/);
    assert.match(md, /## You\n\nwhy is this failing\?/);
    assert.match(md, /## Kiro CLI\n\nBecause of a typo\./);
  });

  it("renders edits as fenced diff blocks", () => {
    const md = toMarkdown(record, [
      { seq: 1, ts: 0, type: "tool_call", toolCallId: "t", title: "Edit", kind: "edit", status: "in_progress", raw: {} },
      {
        seq: 2, ts: 0, type: "tool_call_update", toolCallId: "t", status: "completed",
        raw: { content: [{ type: "diff", path: "a.ts", oldText: "old", newText: "new" }] },
      },
    ]);
    assert.match(md, /```diff/);
    assert.match(md, /-old/);
    assert.match(md, /\+new/);
    assert.match(md, /a\.ts/);
  });

  it("records errors and permission decisions", () => {
    const md = toMarkdown(record, [
      { seq: 1, ts: 0, type: "permission_request", requestId: "r", title: "Delete files?", options: [] },
      { seq: 2, ts: 0, type: "permission_resolved", requestId: "r", optionId: "yes", outcome: "selected" },
      { seq: 3, ts: 0, type: "error", error: { code: "RPC_ERROR", message: "boom" } },
    ]);
    assert.match(md, /Delete files\?/);
    assert.match(md, /Answered: yes/);
    assert.match(md, /RPC_ERROR/);
  });

  it("works for a conversation with no events at all", () => {
    assert.match(toMarkdown(record, []), /^# Fix the parser/);
  });
});

describe("exportFilename", () => {
  it("builds a safe filename from the date and title", () => {
    assert.equal(exportFilename(record), "2026-01-15-fix-the-parser.md");
  });

  it("copes with an untitled conversation and with punctuation", () => {
    assert.equal(exportFilename({ ...record, title: null }), "2026-01-15-conversation.md");
    assert.equal(exportFilename({ ...record, title: "!!! ???" }), "2026-01-15-conversation.md");
    assert.ok(!exportFilename({ ...record, title: "a/b\\c" }).includes("/"));
  });
});
