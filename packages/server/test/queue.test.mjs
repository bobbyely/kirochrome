// The queue and the promise a prompt returns, against the mock agent. Split
// from session.test.mjs for time: each of these rides the mock's ten-second
// "long" turn, and the file cap is forty-five.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "..", "..", "..", "spike", "mock-agent.mjs");
const provider = { id: "mock", name: "Mock", command: process.execPath, args: [MOCK] };

let Store, SessionManager, latestUsage, dir, store, sessions;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-session-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: [provider] }));
  ({ Store } = await import("../dist/store.js"));
  ({ SessionManager } = await import("../dist/sessionManager.js"));
  ({ latestUsage } = await import("@kirochrome/shared"));
  store = new Store(join(dir, "test.db"));
  sessions = new SessionManager(store);
});
after(() => {
  sessions?.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until `fn()` is true, or gives up — for state a process changes. */
async function until(fn, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

/** Answers permission prompts so a turn can complete unattended. */
function autoApprove(session) {
  return session.subscribe((events) => {
    for (const e of events) {
      if (e.type === "permission_request") session.resolvePermission(e.requestId, e.options[0]?.optionId ?? null);
    }
  });
}

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

  it("interrupt sends now: the running turn is cancelled and the queue waits behind it", async () => {
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);

    const running = session.prompt("long");
    await new Promise((r) => setTimeout(r, 150));
    void session.prompt("later");
    // Like `prompt`, `interrupt` resolves when its own turn ends — so look at
    // the queue before waiting on it.
    const interrupted = session.interrupt("now");
    assert.deepEqual(session.summary().queued, ["now", "later"], "the interruption jumps the queue");

    await running;
    await interrupted;
    await new Promise((r) => setTimeout(r, 800));
    off();

    const events = session.eventsSince(0);
    const shape = events
      .filter((e) => ["user_message", "interrupted", "turn_end"].includes(e.type))
      .map((e) => (e.type === "user_message" ? e.text : e.type === "turn_end" ? `end:${e.stopReason}` : e.type));
    assert.deepEqual(shape, ["long", "interrupted", "end:cancelled", "now", "end:end_turn", "later", "end:end_turn"]);
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


describe("a prompt's promise", () => {
  it("resolves when that message's turn ends, not when the queue happens to be idle", async () => {
    // `prompt()` used to return at once while a turn was running. A scheduled
    // run then recorded success having sent nothing, and a room read the
    // *running* turn's text as this message's reply.
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    void session.prompt("long"); // the mock's slow path
    await new Promise((r) => setTimeout(r, 150));

    await session.prompt("second");
    const log = session.eventsSince(0);
    const sent = log.findIndex((e) => e.type === "user_message" && e.text === "second");
    assert.ok(sent > 0, "the second message was sent");
    assert.ok(
      log.slice(sent).some((e) => e.type === "turn_end"),
      "and its own turn had ended by the time the promise resolved",
    );
    off();
    session.close();
  });

  it("queues behind an opening message rather than skipping it", async () => {
    const session = await sessions.open(provider, "/tmp", { opening: "opening line" });
    const off = autoApprove(session);
    await session.prompt("after");
    const said = session.eventsSince(0).filter((e) => e.type === "user_message").map((e) => e.text);
    assert.deepEqual(said, ["opening line", "after"]);
    off();
    session.close();
  });

  it("is released, not left hanging, when its message is dropped", async () => {
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    void session.prompt("long");
    await new Promise((r) => setTimeout(r, 150));
    const waiting = session.prompt("never sent");
    session.unqueue(0);
    await Promise.race([waiting, new Promise((_, rej) => setTimeout(() => rej(new Error("hung")), 2_000))]);
    await session.cancel();
    off();
    session.close();
  });
});
