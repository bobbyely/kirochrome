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

describe("a dying agent", () => {
  const dying = {
    id: "dying",
    name: "Dying",
    command: process.execPath,
    args: [join(here, "..", "..", "..", "spike", "dying-agent.mjs")],
  };

  /** A provider that has passed its check, which is what staleness undoes. */
  const markChecked = (id) =>
    store.saveCheck({
      providerId: id,
      status: "ok",
      stage: "capabilities",
      stages: [],
      checkedAt: Date.now(),
      durationMs: 1,
    });

  it("does not condemn the provider for one conversation crashing", async () => {
    markChecked("dying");
    const first = await sessions.open(dying, "/tmp");
    // A completed turn proves the provider itself is configured correctly.
    await first.prompt("hello");

    const second = await sessions.open(dying, "/tmp");
    await second.prompt("hello");

    // The mock exits 1 shortly after connecting; wait for both to die.
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(first.summary().live, false, "the crash is still noticed");

    assert.equal(
      store.lastCheck("dying").status,
      "ok",
      "a crashed session must not remove the provider from the new-chat list",
    );
  });

  it("does condemn a provider whose agent dies before it ever answers", async () => {
    markChecked("dying");
    const session = await sessions.open(dying, "/tmp");
    // No prompt: nothing has shown this provider can do its job.
    await new Promise((r) => setTimeout(r, 1200));

    assert.equal(session.summary().live, false);
    assert.equal(
      store.lastCheck("dying").status,
      "stale",
      "an agent that never completed a turn is real evidence against the provider",
    );
  });

  it("does not condemn a provider for a shutdown we asked for", async () => {
    markChecked("mock");
    const session = await sessions.open(provider, "/tmp");
    session.close();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(store.lastCheck("mock").status, "ok");
  });
});

describe("compaction", () => {
  it("is advertised, so the agent is allowed to report it", async () => {
    const session = await sessions.open(provider, "/tmp");
    await session.prompt("compact");

    const log = session.eventsSince(0);
    const said = log.filter((e) => e.type === "agent_text").map((e) => e.text).join("");
    assert.ok(
      !said.includes("not advertised"),
      "the mock refuses to send compaction updates unless we ask for them",
    );

    // The updates are recorded raw; the transcript derives the row from them.
    const updates = log
      .filter((e) => e.type === "agent_update")
      .map((e) => e.update)
      .filter((u) => String(u.sessionUpdate).startsWith("compaction"));
    assert.deepEqual(
      updates.map((u) => `${u.sessionUpdate}:${u.compactionId}`),
      [
        "compaction_update:c1",
        "compaction_summary_chunk:c1",
        "compaction_summary_chunk:c1",
        "compaction_update:c1",
        "compaction_update:c2",
        "compaction_update:c2",
      ],
    );
    session.close();
  });
});

describe("elicitation", () => {
  it("asks the form, holds the agent open, and returns coerced content", async () => {
    const session = await sessions.open(provider, "/tmp");

    let asked = null;
    const off = session.subscribe((events) => {
      for (const e of events) {
        if (e.type !== "elicitation_request") continue;
        asked = e;
        // The browser sends strings; the schema asked for a number, a boolean
        // and an array, so the server must coerce before the agent sees it.
        session.resolveElicitation(e.requestId, "accept", {
          channel: "beta",
          notes: "nightly",
          bump: "2",
          sign: false,
          targets: ["linux", "windows", "solaris"],
          uninvited: "should be dropped",
        });
      }
    });

    await session.prompt("elicit");
    off();

    assert.ok(asked, "the agent's question must reach the log");
    assert.equal(asked.message, "Which release should I cut?");
    assert.equal(asked.title, "Release options");

    const byKey = Object.fromEntries(asked.fields.map((f) => [f.key, f]));
    assert.deepEqual(Object.keys(byKey).sort(), ["bump", "channel", "notes", "sign", "targets"]);
    assert.equal(byKey.weird, undefined, "an unrenderable optional field is dropped");
    assert.equal(byKey.channel.type, "select");
    assert.equal(byKey.channel.required, true);
    assert.deepEqual(byKey.channel.choices.map((c) => c.value), ["stable", "beta"]);
    assert.equal(byKey.channel.choices[1].label, "Beta", "titled enums keep their titles");
    assert.equal(byKey.notes.type, "text");
    assert.equal(byKey.notes.required, false);
    assert.equal(byKey.bump.type, "number");
    assert.equal(byKey.bump.integer, true);
    assert.equal(byKey.sign.type, "boolean");
    assert.equal(byKey.sign.default, true);
    assert.deepEqual(byKey.targets.choices.map((c) => c.value), ["linux", "macos", "windows"]);

    const resolved = session.eventsSince(0).find((e) => e.type === "elicitation_resolved");
    assert.equal(resolved.action, "accept");
    assert.deepEqual(
      resolved.content,
      { channel: "beta", notes: "nightly", bump: 2, sign: false, targets: ["linux", "windows"] },
      "numbers parsed, unknown keys and values outside the schema dropped",
    );

    // The agent received exactly what we recorded, so the log is not a
    // flattering version of what happened.
    const echo = session.eventsSince(0).filter((e) => e.type === "agent_text").map((e) => e.text).join("");
    assert.ok(echo.includes('"action":"accept"'), `agent saw: ${echo}`);
    assert.ok(echo.includes('"bump":2'), `agent saw: ${echo}`);
    session.close();
  });

  it("declines a mode it never advertised, instead of hanging", async () => {
    const session = await sessions.open(provider, "/tmp");
    await session.prompt("elicit-url");

    const log = session.eventsSince(0);
    assert.equal(log.at(-1).type, "turn_end", "the turn must still finish");
    assert.ok(
      log.some((e) => e.type === "error" && e.error.detail?.mode === "url"),
      "the refusal is recorded, not silent",
    );
    const echo = log.filter((e) => e.type === "agent_text").map((e) => e.text).join("");
    assert.ok(echo.includes('"action":"decline"'), `agent saw: ${echo}`);
    session.close();
  });

  it("declines a form whose required field it cannot render", async () => {
    const session = await sessions.open(provider, "/tmp");
    await session.prompt("elicit-unrenderable");

    const log = session.eventsSince(0);
    assert.ok(
      log.some((e) => e.type === "error" && e.error.detail?.key === "colour"),
      "the field we could not render is named",
    );
    assert.ok(!log.some((e) => e.type === "elicitation_request"), "no unanswerable form is shown");
    const echo = log.filter((e) => e.type === "agent_text").map((e) => e.text).join("");
    assert.ok(echo.includes('"action":"decline"'), `agent saw: ${echo}`);
    session.close();
  });

  it("cancels anything still waiting when the session closes", async () => {
    const session = await sessions.open(provider, "/tmp");
    let seen = false;
    const off = session.subscribe((events) => {
      // Deliberately never answer: closing must release the agent instead.
      for (const e of events) if (e.type === "elicitation_request") seen = true;
    });

    const turn = session.prompt("elicit");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(seen, "the question was asked");
    assert.equal(session.summary().awaitingInput, true, "the session reports it is blocked");

    session.close();
    await turn; // must settle, not hang
    off();
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
