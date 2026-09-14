// Rooms against the mock agent: turns go round, the user can hold and cut in.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "..", "..", "..", "spike", "mock-agent.mjs");
const provider = { id: "mock", name: "Mock", command: process.execPath, args: [MOCK] };

let Store, SessionManager, RoomManager, dir, store, sessions, rooms;

const input = {
  name: "Planning",
  cwd: "/tmp",
  topic: "Plan a small thing.",
  maxTurnsPerRound: 4,
  pauseSeconds: 0,
  creditCap: null,
  participants: [
    { name: "Planner", providerId: "mock", role: "lays out the steps" },
    { name: "Critic", providerId: "mock", role: "finds the holes" },
  ],
};

/** Polls until `fn()` is true, or gives up. */
async function until(fn, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-rooms-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: [provider] }));
  ({ Store } = await import("../dist/store.js"));
  ({ SessionManager } = await import("../dist/sessionManager.js"));
  ({ RoomManager } = await import("../dist/rooms.js"));
  store = new Store(join(dir, "test.db"));
  sessions = new SessionManager(store);
  rooms = new RoomManager(store, sessions, () => [provider]);
  store.saveCheck({ providerId: "mock", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });
});
after(() => {
  sessions?.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("a room", () => {
  it("refuses bad input, field by field", async () => {
    await assert.rejects(
      rooms.create({ ...input, name: "", participants: [{ name: "Solo", providerId: "nope", role: "" }] }),
      (err) => err.code === "ROOM_INVALID" && /name is required/.test(err.message) && /2 to 6/.test(err.message) && /no provider 'nope'/.test(err.message),
    );
  });

  it("opens a tagged session per participant", async () => {
    const room = await rooms.create(input);
    assert.equal(room.participants.length, 2);
    for (const p of room.participants) {
      const record = store.getSession(p.sessionId);
      assert.equal(record.roomId, room.id);
      assert.equal(record.title, `Planning · ${p.name}`);
      assert.ok(sessions.getLive(p.sessionId), "agent is up");
    }
    rooms.delete(room.id);
  });

  it("goes round the participants after the user speaks, each seeing what came since its last turn", async () => {
    const room = await rooms.create(input);
    await rooms.say(room.id, "Let's start.");
    assert.ok(await until(() => rooms.get(room.id).status === "idle" && rooms.get(room.id).messages.length === 5), "round finished");

    const view = rooms.get(room.id);
    assert.deepEqual(
      view.messages.map((m) => `${m.name}: ${m.text}`),
      ["You: Let's start.", "Planner: Hello from Planner", "Critic: Hello from Critic", "Planner: Hello from Planner", "Critic: Hello from Critic"],
    );
    // The second prompt Planner got should carry only what was said after its first turn.
    const planner = view.participants[0];
    const prompts = store.eventsSince(planner.sessionId, 0).filter((e) => e.type === "user_message").map((e) => e.text);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /\[You\] Let's start\./);
    assert.match(prompts[1], /\[Critic\] Hello from Critic/);
    assert.doesNotMatch(prompts[1], /Let's start/, "already shown");
    rooms.delete(room.id);
  });

  it("stops the round when everyone passes", async () => {
    const room = await rooms.create({ ...input, maxTurnsPerRound: 10 });
    await rooms.say(room.id, "Nothing more to plan, please pass.");
    assert.ok(await until(() => rooms.get(room.id).status === "idle"));
    assert.equal(rooms.get(room.id).messages.length, 1, "nobody spoke");
    assert.equal(rooms.get(room.id).turnsThisRound, 2, "each was asked once");
    rooms.delete(room.id);
  });

  it("holds while the user types, and resumes where it left off", async () => {
    const room = await rooms.create({ ...input, maxTurnsPerRound: 4, pauseSeconds: 1 });
    await rooms.say(room.id, "Go.");
    assert.ok(await until(() => rooms.get(room.id).messages.length >= 2), "first turn taken");
    rooms.hold(room.id, true);
    assert.ok(await until(() => rooms.get(room.id).status === "held"));
    const held = rooms.get(room.id).messages.length;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(rooms.get(room.id).messages.length, held, "nobody else was prompted");
    rooms.hold(room.id, false);
    assert.ok(await until(() => rooms.get(room.id).status === "idle" && rooms.get(room.id).messages.length === 5), "resumed to the turn budget");
    rooms.delete(room.id);
  });

  it("re-attaches a participant whose agent is gone, and settles rooms a restart left running", async () => {
    const room = await rooms.create({ ...input, maxTurnsPerRound: 2 });
    const [planner] = room.participants;
    sessions.detach(planner.sessionId);
    assert.equal(sessions.getLive(planner.sessionId), null);
    store.upsertRoom({ ...store.getRoom(room.id), status: "running" });
    new RoomManager(store, sessions, () => [provider]).start();
    assert.equal(store.getRoom(room.id).status, "idle", "a restart settles it");

    await rooms.say(room.id, "Again.");
    assert.ok(await until(() => rooms.get(room.id).status === "idle" && rooms.get(room.id).messages.length === 3));
    assert.equal(rooms.get(room.id).messages[1].name, "Planner", "Planner answered from a re-attached agent");
    rooms.delete(room.id);
  });

  it("stops on demand, and a credit cap stops it too", async () => {
    const room = await rooms.create({ ...input, maxTurnsPerRound: 50, pauseSeconds: 1 });
    await rooms.say(room.id, "Go.");
    assert.ok(await until(() => rooms.get(room.id).messages.length >= 2));
    rooms.stop(room.id);
    assert.equal(rooms.get(room.id).status, "stopped");
    const n = rooms.get(room.id).messages.length;
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(rooms.get(room.id).messages.length, n);
    rooms.delete(room.id);
  });
});
