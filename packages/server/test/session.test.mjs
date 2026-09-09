// End-to-end against the mock agent: the behaviours that were previously only
// verified by throwaway scripts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "..", "..", "..", "spike", "mock-agent.mjs");
const provider = { id: "mock", name: "Mock", command: process.execPath, args: [MOCK] };

let Store, SessionManager, dir, store, sessions;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-session-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: [provider] }));
  ({ Store } = await import("../dist/store.js"));
  ({ SessionManager } = await import("../dist/sessionManager.js"));
  store = new Store(join(dir, "test.db"));
  sessions = new SessionManager(store);
});
after(() => {
  sessions?.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

/** Answers permission prompts so a turn can complete unattended. */
function autoApprove(session) {
  return session.subscribe((events) => {
    for (const e of events) {
      if (e.type === "permission_request") session.resolvePermission(e.requestId, e.options[0]?.optionId ?? null);
    }
  });
}

describe("a turn", () => {
  it("streams, coalesces text, and records a durable log", async () => {
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    await session.prompt("hello");
    off();

    const log = session.eventsSince(0);
    assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1), "seq must be gapless and monotonic");
    assert.equal(log[0].type, "user_message");
    assert.equal(log.at(-1).type, "turn_end");

    // The mock emits "PROBE", "_", "OK" as three chunks; they must arrive as one.
    const text = log.filter((e) => e.type === "agent_text").map((e) => e.text);
    assert.ok(text.some((t) => t.includes("PROBE_OK")), `expected coalesced text, got ${JSON.stringify(text)}`);

    // Everything in memory is also on disk.
    assert.deepEqual(store.eventsSince(session.id, 0).map((e) => e.seq), log.map((e) => e.seq));
    session.close();
  });

  it("titles itself from the agent, and a rename then wins", async () => {
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    await session.prompt("first message");
    assert.equal(session.summary().title, "Mock session", "the agent names its own session");

    session.rename("My name");
    await session.prompt("second message");
    assert.equal(session.summary().title, "My name", "the agent must not rename it back");
    off();
    session.close();
  });
});

describe("the queue", () => {
  it("holds messages typed during a turn and runs them in order", async () => {
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);

    const running = session.prompt("long");           // the mock's slow path
    await new Promise((r) => setTimeout(r, 150));
    void session.prompt("second");
    void session.prompt("third");
    assert.deepEqual(session.summary().queued, ["second", "third"]);

    session.moveQueued(1, 0);
    assert.deepEqual(session.summary().queued, ["third", "second"]);
    session.editQueued(0, "THIRD");
    assert.deepEqual(session.summary().queued, ["THIRD", "second"]);

    await running;
    await new Promise((r) => setTimeout(r, 800));
    off();

    const said = session.eventsSince(0).filter((e) => e.type === "user_message").map((e) => e.text);
    assert.deepEqual(said, ["long", "THIRD", "second"]);
    session.close();
  });

  it("ignores out-of-range edits rather than corrupting itself", async () => {
    const session = await sessions.open(provider, "/tmp");
    session.moveQueued(5, 0);
    session.editQueued(-1, "x");
    session.unqueue(99);
    assert.deepEqual(session.summary().queued, []);
    session.close();
  });
});

describe("a restored conversation", () => {
  it("replays from disk and refuses prompts until an agent is re-attached", async () => {
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    await session.prompt("remember this");
    const id = session.id;
    off();
    const before = session.eventsSince(0).length;

    // Simulate a restart: a fresh manager over the same database.
    const revived = new SessionManager(store);
    assert.equal(revived.getLive(id), null);
    assert.equal(revived.eventsSince(id, 0).length, before, "the transcript survives");
    assert.equal(revived.summary(id).live, false);
    assert.throws(() => revived.requireLive(id), (e) => e.code === "SESSION_NOT_LIVE");

    const resumed = await revived.resume(id, provider);
    assert.equal(resumed.summary().live, true);
    assert.ok(resumed.summary().configOptions.length > 0, "session/load must repopulate the pickers");

    // The agent replays its own history on load; ours must not double up.
    const history = resumed.eventsSince(0).filter((e) => e.type === "agent_text").map((e) => e.text);
    assert.ok(!history.some((t) => t.includes("HISTORY")), "the agent's replay must be discarded");
    revived.closeAll();
    session.close();
  });
});

describe("concurrent resume", () => {
  it("returns one session for simultaneous resumes, not two", async () => {
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    await session.prompt("first");
    off();
    const id = session.id;
    session.close();
    sessions.closeAll();

    const revived = new SessionManager(store);
    // Two tabs, or a double-clicked Resume: both arrive before the handshake
    // finishes. Two Session objects would append from the same seq and
    // violate UNIQUE(session_id, seq).
    const [a, b, c] = await Promise.all([
      revived.resume(id, provider),
      revived.resume(id, provider),
      revived.resume(id, provider),
    ]);
    assert.equal(a, b, "concurrent resumes must share one session");
    assert.equal(b, c);

    const approve = autoApprove(a);
    await a.prompt("second");
    approve();

    const seqs = store.eventsSince(id, 0).map((e) => e.seq);
    assert.deepEqual(seqs, [...new Set(seqs)], "seq must stay unique on disk");
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), "and monotonic");
    revived.closeAll();
  });
});

describe("provider defaults", () => {
  it("re-apply to a new session, and survive a withdrawn option", async () => {
    const first = await sessions.open(provider, "/tmp");
    await first.setConfigOption("model", "mock-small");
    first.close();

    const second = await sessions.open(provider, "/tmp");
    const model = second.summary().configOptions.find((o) => o.id === "model");
    assert.equal(model.currentValue, "mock-small", "the choice should stick");
    second.close();

    // A default the agent no longer offers must not break the session.
    store.setProviderDefault("mock", "model", "withdrawn-model");
    const third = await sessions.open(provider, "/tmp");
    const fallback = third.summary().configOptions.find((o) => o.id === "model");
    assert.equal(fallback.currentValue, "mock-large", "falls back to the agent's own default");
    third.close();
  });
});
