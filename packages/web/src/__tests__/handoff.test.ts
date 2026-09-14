import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handoffText, withHandoff } from "@kirochrome/shared";
import type { KcEvent } from "@kirochrome/shared";

let seq = 0;
const ev = (e: Omit<KcEvent, "seq" | "ts">): KcEvent => ({ ...e, seq: ++seq, ts: 0 }) as KcEvent;
const kiro = { id: "kiro", name: "Kiro" };
const claude = { id: "claude", name: "Claude Code" };
const gemini = { id: "gemini", name: "Gemini" };

describe("the handoff", () => {
  it("attributes each reply to the provider that gave it, across more than one switch", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", text: "Plan it." }),
      ev({ type: "agent_text", text: "Here is a plan." }),
      ev({ type: "provider_switched", from: kiro, to: claude, throughSeq: 2 }),
      ev({ type: "user_message", text: "Build it." }),
      ev({ type: "tool_call", toolCallId: "t1", title: "Edit", kind: "edit", status: "in_progress", raw: {} }),
      ev({ type: "tool_call_update", toolCallId: "t1", raw: { content: [{ type: "diff", path: "a.ts", oldText: "x\ny", newText: "z" }] } }),
      ev({ type: "agent_text", text: "Built." }),
      ev({ type: "agent_update", update: { sessionUpdate: "usage_update", used: 9 } }),
    ];
    const { text, messages, omitted } = handoffText(events, 8, claude, "/proj");
    assert.equal(omitted, 0);
    assert.equal(messages, 6);
    assert.match(text, /began with another assistant, Claude Code/);
    assert.match(text, /already on disk in \/proj/);
    assert.match(text, /Person:\nPlan it\.\n\nKiro:\nHere is a plan\./, "the first reply was Kiro's");
    assert.match(text, /\[The conversation moved from Kiro to Claude Code here\.\]/);
    assert.match(text, /\[Edit: a\.ts \(\+1 −2\)\]/);
    assert.match(text, /Claude Code:\nBuilt\./, "the second was Claude Code's");
    assert.doesNotMatch(text, /usage/);
  });

  it("stops at throughSeq and drops the oldest whole messages to fit, saying how many", () => {
    seq = 0;
    const events = Array.from({ length: 10 }, (_, i) => ev({ type: "user_message", text: `message ${i} ${"x".repeat(100)}` }));
    events.push(ev({ type: "user_message", text: "after the switch" }));
    const { text, messages, omitted } = handoffText(events, 10, gemini, "/p", 900);
    assert.equal(messages, 10);
    assert.ok(omitted > 0 && omitted < 10, `dropped some: ${omitted}`);
    assert.match(text, new RegExp(`omitted to fit: ${omitted} messages`));
    assert.match(text, /message 9/, "the newest survives");
    assert.doesNotMatch(text, /message 0 /, "the oldest goes first");
    assert.doesNotMatch(text, /after the switch/, "nothing past throughSeq");
    assert.ok(text.length <= 900);
  });

  it("puts the person's message after the transcript", () => {
    seq = 0;
    const handoff = handoffText([ev({ type: "user_message", text: "hi" })], 1, kiro, "/p");
    assert.match(withHandoff(handoff, "carry on"), /--- end of transcript ---\n\nThe person now says:\n\ncarry on$/);
  });
});
