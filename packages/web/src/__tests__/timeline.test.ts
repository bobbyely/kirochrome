import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KcEvent } from "@kirochrome/shared";
import { latestUsage } from "@kirochrome/shared";
import { buildRows, toolContent, toolSubtitle } from "../timeline.ts";

const ev = (e: Partial<KcEvent> & { type: KcEvent["type"] }, seq: number): KcEvent =>
  ({ seq, ts: 0, ...e }) as KcEvent;

const tool = (seq: number, id: string, status: string, title = "Read") =>
  ev({ type: "tool_call", toolCallId: id, title, kind: "read", status, raw: {} } as never, seq);

describe("buildRows", () => {
  it("merges consecutive agent text so flush boundaries are invisible", () => {
    const rows = buildRows([
      ev({ type: "agent_text", text: "PROBE" } as never, 1),
      ev({ type: "agent_text", text: "_OK" } as never, 2),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind === "agent" && rows[0]!.text, "PROBE_OK");
  });

  it("folds a tool call and all its updates into one row", () => {
    const rows = buildRows([
      tool(1, "a", "pending"),
      ev({ type: "tool_call_update", toolCallId: "a", status: "in_progress", raw: {} } as never, 2),
      ev({ type: "tool_call_update", toolCallId: "a", status: "completed", raw: { title: "git status" } } as never, 3),
      ev({ type: "agent_text", text: "done" } as never, 4),
    ]);
    const toolRow = rows.find((r) => r.kind === "tool");
    assert.ok(toolRow && toolRow.kind === "tool");
    assert.equal(toolRow.status, "completed");
    // A later update carries the real title — the command actually run.
    assert.equal(toolRow.title, "git status");
    assert.equal(toolRow.details.length, 3);
  });

  it("groups consecutive tool calls but never across an answer", () => {
    const rows = buildRows([
      tool(1, "a", "completed"),
      tool(2, "b", "completed"),
      ev({ type: "agent_text", text: "mid" } as never, 3),
      tool(4, "c", "completed"),
      tool(5, "d", "completed"),
    ]);
    const groups = rows.filter((r) => r.kind === "work");
    assert.equal(groups.length, 2, "the answer between them must split the groups");
    assert.deepEqual(groups.map((g) => g.kind === "work" && g.tools), [2, 2]);
  });

  it("leaves a lone tool call ungrouped", () => {
    const rows = buildRows([tool(1, "a", "completed"), ev({ type: "agent_text", text: "x" } as never, 2)]);
    assert.equal(rows.filter((r) => r.kind === "work").length, 0);
    assert.equal(rows.filter((r) => r.kind === "tool").length, 1);
  });

  it("reports a group as active while any tool is unfinished", () => {
    const rows = buildRows([tool(1, "a", "completed"), tool(2, "b", "in_progress")]);
    const group = rows.find((r) => r.kind === "work");
    assert.ok(group && group.kind === "work" && group.active);
  });

  it("keeps session-state updates out of the transcript", () => {
    const rows = buildRows([
      ev({ type: "agent_update", update: { sessionUpdate: "usage_update", used: 1, size: 2 } } as never, 1),
      ev({ type: "agent_update", update: { sessionUpdate: "session_info_update", title: "x" } } as never, 2),
      ev({ type: "agent_text", text: "hello" } as never, 3),
    ]);
    assert.deepEqual(rows.map((r) => r.kind), ["agent"]);
  });

  it("upserts a compaction by id and keeps a summary an update does not mention", () => {
    const update = (u: Record<string, unknown>, seq: number) =>
      ev({ type: "agent_update", update: { sessionUpdate: "compaction_update", ...u } } as never, seq);
    const chunk = (text: string, seq: number) =>
      ev({
        type: "agent_update",
        update: { sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: { type: "text", text } },
      } as never, seq);

    const rows = buildRows([
      update({ compactionId: "c1", status: "in_progress" }, 1),
      chunk("Earlier we ", 2),
      chunk("set up CI.", 3),
      // No `summary` key: omission must leave the chunks alone, not clear them.
      update({ compactionId: "c1", status: "completed" }, 4),
    ]);

    assert.equal(rows.length, 1, "later updates patch the row rather than adding one");
    const row = rows[0]!;
    assert.ok(row.kind === "compaction");
    assert.equal(row.status, "completed");
    assert.equal(row.summary, "Earlier we set up CI.");
    assert.equal(row.seq, 1, "it sits where the compaction began");
  });

  it("clears a compaction summary on an explicit empty one, and keeps an error", () => {
    const rows = buildRows([
      ev({ type: "agent_update", update: { sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress", summary: [{ text: "draft" }] } } as never, 1),
      ev({ type: "agent_update", update: { sessionUpdate: "compaction_update", compactionId: "c1", status: "failed", summary: [], error: "no" } } as never, 2),
    ]);
    const row = rows[0]!;
    assert.ok(row.kind === "compaction");
    assert.equal(row.summary, "", "`summary: []` clears, unlike omission");
    assert.equal(row.error, "no");
  });

  it("folds an elicitation and its answer into one row", () => {
    const fields = [{ key: "channel", label: "Channel", required: true, type: "text" as const }];
    const rows = buildRows([
      ev({ type: "elicitation_request", requestId: "e1", message: "Which?", fields } as never, 1),
      ev({ type: "elicitation_resolved", requestId: "e1", action: "accept", content: { channel: "beta" } } as never, 2),
    ]);
    assert.equal(rows.length, 1, "the answer must not add a second row");
    const row = rows[0]!;
    assert.ok(row.kind === "elicitation");
    assert.deepEqual(row.answer, { action: "accept", content: { channel: "beta" } });
  });

  it("leaves an unanswered elicitation open, which is what shows the form", () => {
    const rows = buildRows([
      ev({ type: "elicitation_request", requestId: "e1", message: "Which?", fields: [] } as never, 1),
    ]);
    assert.equal(rows[0]!.kind === "elicitation" && rows[0]!.answer, null);
  });
});

describe("toolContent", () => {
  it("extracts diffs and text, ignoring earlier revisions", () => {
    const content = toolContent([
      { content: [{ type: "content", content: { type: "text", text: "old" } }] },
      { content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y" }] },
    ]);
    assert.equal(content.diffs.length, 1);
    assert.equal(content.diffs[0]!.path, "a.ts");
    assert.equal(content.texts.length, 0, "the latest update with content wins");
  });

  it("finds a command or path for the card subtitle", () => {
    assert.equal(toolSubtitle([{ rawInput: { command: "ls -la" } }]), "ls -la");
    assert.equal(toolSubtitle([{ rawInput: { file_path: "src/a.ts" } }]), "src/a.ts");
    assert.equal(toolSubtitle([{}]), null);
  });
});

describe("latestUsage", () => {
  it("reads the most recent usage update from the log", () => {
    const usage = latestUsage([
      ev({ type: "agent_update", update: { sessionUpdate: "usage_update", used: 10, size: 100 } } as never, 1),
      ev({ type: "agent_text", text: "hi" } as never, 2),
      ev({ type: "agent_update", update: { sessionUpdate: "usage_update", used: 30, size: 100, cost: { amount: 0.5, currency: "USD" } } } as never, 3),
    ]);
    assert.equal(usage?.used, 30, "the latest update wins");
    assert.equal(usage?.cost?.currency, "USD");
  });

  it("returns null when the agent has never reported usage", () => {
    assert.equal(latestUsage([ev({ type: "agent_text", text: "hi" } as never, 1)]), null);
  });

  it("ignores a malformed usage update rather than showing nonsense", () => {
    assert.equal(
      latestUsage([ev({ type: "agent_update", update: { sessionUpdate: "usage_update" } } as never, 1)]),
      null,
    );
  });
});

describe("an adopted conversation", () => {
  it("renders the replayed user side as user rows, not as unnamed notes", () => {
    // An adopted history arrives as ACP updates, so what the user said is a
    // `user_message_chunk` rather than one of our `user_message` events.
    const rows = buildRows([
      ev({ type: "agent_update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "WHAT " } } } as never, 1),
      ev({ type: "agent_update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "I ASKED" } } } as never, 2),
      ev({ type: "agent_text", text: "OLD HISTORY" } as never, 3),
    ]);

    assert.deepEqual(rows.map((r) => r.kind), ["user", "agent"]);
    assert.equal(rows[0]!.kind === "user" && rows[0]!.text, "WHAT I ASKED");
  });

  it("shows the seam where the agent's history ends and ours begins", () => {
    const rows = buildRows([
      ev({ type: "agent_text", text: "replayed" } as never, 1),
      ev({ type: "adopted", agentSessionId: "cli-1", providerName: "Mock" } as never, 2),
      ev({ type: "user_message", text: "carry on" } as never, 3),
    ]);

    assert.deepEqual(rows.map((r) => r.kind), ["agent", "adopted", "user"]);
    assert.equal(rows[1]!.kind === "adopted" && rows[1]!.providerName, "Mock");
  });
});
