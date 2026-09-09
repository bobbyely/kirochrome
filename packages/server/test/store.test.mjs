// Runs against the compiled output, so it exercises what actually ships.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let Store, dir, store;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-store-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  ({ Store } = await import("../dist/store.js"));
  store = new Store(join(dir, "test.db"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const session = (id, over = {}) => ({
  id, agentSessionId: null, providerId: "p", providerName: "P", cwd: "/tmp",
  title: null, status: "active", createdAt: 1, updatedAt: 1, titleLocked: false, ...over,
});
const event = (seq, type, extra = {}) => ({ seq, ts: seq, type, ...extra });

describe("event log", () => {
  it("returns only events after the given seq", () => {
    store.upsertSession(session("s1"));
    for (let i = 1; i <= 5; i++) store.appendEvent("s1", event(i, "agent_text", { text: `m${i}` }));

    assert.equal(store.eventsSince("s1", 0).length, 5);
    assert.deepEqual(store.eventsSince("s1", 3).map((e) => e.seq), [4, 5]);
    assert.equal(store.lastSeq("s1"), 5);
  });

  it("keeps each session's log separate", () => {
    store.upsertSession(session("s2"));
    store.appendEvent("s2", event(1, "user_message", { text: "other" }));
    assert.equal(store.eventsSince("s2", 0).length, 1);
    assert.equal(store.eventsSince("s1", 0).length, 5);
  });
});

describe("search", () => {
  it("finds a conversation by what was said, and highlights the match", () => {
    store.upsertSession(session("s3", { title: "Notes" }));
    store.appendEvent("s3", event(1, "user_message", { text: "postgres migration plan" }));

    const hits = store.searchSessions("postgres");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, "s3");
    assert.match(hits[0].snippet, /postgres/i);
  });

  it("treats malformed input as a literal search rather than failing", () => {
    // FTS5 MATCH is a query language; unquoted input like this is a syntax error.
    for (const bad of ['zzz("', "AND", "* OR", '"'])
      assert.doesNotThrow(() => store.searchSessions(bad), `threw on ${bad}`);
    assert.deepEqual(store.searchSessions("   "), []);
  });

  it("indexes only what was said, not machinery", () => {
    store.upsertSession(session("s4"));
    store.appendEvent("s4", event(1, "agent_update", { update: { sessionUpdate: "usage_update" } }));
    assert.deepEqual(store.searchSessions("usage_update"), []);
  });
});

describe("archiving", () => {
  it("hides a conversation without deleting its log", () => {
    store.upsertSession(session("s5", { title: "Old" }));
    store.appendEvent("s5", event(1, "user_message", { text: "keep me" }));
    store.setArchived("s5", true);

    assert.ok(!store.listSessions(100, false).some((s) => s.id === "s5"));
    assert.ok(store.listSessions(100, true).some((s) => s.id === "s5"));
    assert.equal(store.eventsSince("s5", 0).length, 1, "the log must survive archiving");

    store.setArchived("s5", false);
    assert.ok(store.listSessions(100, false).some((s) => s.id === "s5"));
  });
});

describe("provider defaults", () => {
  it("remembers and returns picker choices", () => {
    store.setProviderDefault("kiro", "model", "big");
    store.setProviderDefault("kiro", "verbose", true);
    const defaults = store.providerDefaults("kiro");
    assert.equal(defaults.get("model"), "big");
    assert.equal(defaults.get("verbose"), true, "booleans must survive the round trip");
    assert.equal(store.providerDefaults("other").size, 0);
  });
});

describe("provider checks", () => {
  it("lets a later stale marking override the stored result", () => {
    // markStale updates the status column; the stored blob still says "ok".
    store.saveCheck({
      providerId: "p1", status: "ok", stage: "capabilities", stages: [],
      checkedAt: 1, durationMs: 1,
    });
    assert.equal(store.lastCheck("p1").status, "ok");
    store.markStale("p1");
    assert.equal(store.lastCheck("p1").status, "stale", "the column must win over the blob");
  });
});

describe("attachments", () => {
  it("stores and returns an image by id", () => {
    store.addAttachment("a1", "s1", "image/png", "AAAA");
    const stored = store.attachment("a1");
    // node:sqlite returns null-prototype rows, so compare fields rather than
    // deep-equalling against an object literal.
    assert.equal(stored.mime, "image/png");
    assert.equal(stored.data, "AAAA");
    assert.equal(store.attachment("missing"), null);
  });
});
