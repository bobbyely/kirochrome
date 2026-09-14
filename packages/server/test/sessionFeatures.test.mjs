// The session's newer behaviours — roots, @ mentions, provider switching —
// against the mock agent. Split from session.test.mjs, which had grown past
// the 45-second file cap; the setup is the same.
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

describe("the Files pane's roots", () => {
  it("are events in the log: added once, removable, the cwd never among them", async () => {
    // The file endpoint's allowlist is replayed from these, so they have to
    // be in the log rather than in the browser (invariants 2 and 3).
    const session = await sessions.open(provider, "/tmp");
    const roots = (events) => events.filter((e) => e.type === "root_added" || e.type === "root_removed").map((e) => `${e.type}:${e.path}`);
    session.setRoot("/tmp", true); // the cwd is always a root; nothing to record
    session.setRoot("/opt", true);
    session.setRoot("/opt", true); // already there
    session.setRoot("/var", false); // never added
    session.setRoot("/opt", false);
    assert.deepEqual(roots(session.eventsSince(0)), ["root_added:/opt", "root_removed:/opt"]);
    assert.deepEqual(roots(store.eventsSince(session.id, 0)), ["root_added:/opt", "root_removed:/opt"], "durable");
    session.close();
  });
});


describe("@ mentions", () => {
  it("go to the agent as resource links, are recorded on the message, and a bad one is an error not a refusal", async () => {
    const session = await sessions.open(provider, dir); // the data dir doubles as the working directory
    await session.prompt("read @config.json and @missing.txt please", [], ["config.json", "missing.txt"]);
    const log = session.eventsSince(0);
    const message = log.find((e) => e.type === "user_message");
    assert.deepEqual(message.files.map((f) => f.name), ["config.json"], "the good one is on the event");
    assert.ok(message.files[0].size > 0);
    assert.equal(message.text, "read @config.json and @missing.txt please", "the text is as typed");
    const reply = log.filter((e) => e.type === "agent_text").at(-1).text;
    // The link is the real path: on macOS /tmp is a symlink and confinement resolves it.
    assert.equal(reply, `[files: config.json@file://${realpathSync(join(dir, "config.json"))}]`, "the agent got a resource link");
    const error = log.find((e) => e.type === "error");
    assert.equal(error?.error.code, "FILE_UNKNOWN", "the missing one is said, and the message still went");
    session.close();
  });
});


describe("switching provider mid-conversation", () => {
  const second = { id: "mock2", name: "Mock Two", command: process.execPath, args: [MOCK] };
  const broken = { id: "broken", name: "Broken", command: join(here, "no-such-agent"), args: [] };
  const switches = (session) => session.eventsSince(0).filter((e) => e.type === "provider_switched");

  it("hands the transcript to the new agent with the next message, and only then", async () => {
    store.saveCheck({ providerId: "mock2", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    await session.prompt("hello");
    const before = session.summary().lastSeq;

    await sessions.switchProvider(session.id, second);
    assert.equal(session.summary().providerName, "Mock Two");
    assert.equal(store.getSession(session.id).providerId, "mock2", "the record follows");
    const [sw] = switches(session);
    assert.deepEqual([sw.from.id, sw.to.id, sw.throughSeq], ["mock", "mock2", before]);
    assert.ok(session.summary().live, "still live");

    // The retired agent exits after the switch; that must not read as the session dying.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(sessions.getLive(session.id), "the old agent's exit is not the session's");
    assert.ok(!session.eventsSince(0).some((e) => e.type === "agent_exited"));

    await session.prompt("and now?");
    const said = session.eventsSince(0).filter((e) => e.type === "agent_text").at(-1).text;
    assert.equal(said, "[handoff: 1 person message(s); now: and now?]");
    const typed = session.eventsSince(0).filter((e) => e.type === "user_message").at(-1).text;
    assert.equal(typed, "and now?", "the log holds what was typed, not the handoff");

    await session.prompt("hello");
    const again = session.eventsSince(0).filter((e) => e.type === "agent_text").at(-1).text;
    assert.doesNotMatch(again, /handoff/, "sent once");
    off();
    session.close();
  });

  it("leaves the conversation where it was when the new provider will not start", async () => {
    store.saveCheck({ providerId: "broken", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });
    const session = await sessions.open(provider, "/tmp");
    const off = autoApprove(session);
    await assert.rejects(sessions.switchProvider(session.id, broken));
    assert.equal(session.summary().providerId, "mock");
    assert.equal(switches(session).length, 0);
    assert.equal(store.lastCheck("broken")?.status, "stale", "the provider that failed is the one marked");
    await session.prompt("hello");
    assert.ok(session.eventsSince(0).some((e) => e.type === "turn_end"), "still usable");
    off();
    session.close();
  });

  it("refuses mid-turn, and a provider that has not passed its check", async () => {
    const session = await sessions.open(provider, "/tmp");
    void session.prompt("long");
    await new Promise((r) => setTimeout(r, 150));
    await assert.rejects(sessions.switchProvider(session.id, second), (e) => e.code === "SESSION_BUSY");
    await session.cancel();
    store.markStale("mock2");
    await assert.rejects(sessions.switchProvider(session.id, second), (e) => e.code === "AGENT_SESSION_FAILED");
    session.close();
  });
});
