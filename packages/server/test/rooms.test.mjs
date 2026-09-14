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
/** A provider whose agent cannot start; the second participant in the spawn-leak case. */
const broken = { id: "broken", name: "Broken", command: join(here, "no-such-agent"), args: [] };

let Store, SessionManager, RoomManager, dir, store, sessions, rooms;

const input = {
  name: "Planning",
  cwd: "/tmp",
  topic: "Plan a small thing.",
  maxTurnsPerRound: 4,
  pauseSeconds: 0,
  creditCap: null,
  participants: [
    { name: "Planner", providerId: "mock", role: "lays out the steps", start: { configValues: { model: "mock-small" } } },
    { name: "Critic", providerId: "mock", role: "finds the holes", start: {} },
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
  rooms = new RoomManager(store, sessions, () => [provider, broken]);
  store.saveCheck({ providerId: "mock", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });
  store.saveCheck({ providerId: "broken", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });
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

  it("opens a tagged session per participant, with its chosen settings", async () => {
    const room = await rooms.create(input);
    assert.equal(room.participants.length, 2);
    const planner = sessions.getLive(room.participants[0].sessionId);
    assert.equal(planner.summary().configOptions.find((o) => o.id === "model")?.currentValue, "mock-small");
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
    assert.match(prompts[0], /<message from="You">\nLet's start\.\n<\/message>/);
    assert.match(prompts[1], /<message from="Critic">\nHello from Critic\n<\/message>/);
    assert.doesNotMatch(prompts[1], /Let's start/, "already shown");
    rooms.delete(room.id);
  });

  it("can be steered: new topic and rules reach the next prompt", async () => {
    const room = await rooms.create({ ...input, maxTurnsPerRound: 1 });
    rooms.steer(room.id, { topic: "Something else entirely", rules: "Answer in haiku." });
    await rooms.say(room.id, "Go.");
    assert.ok(await until(() => rooms.get(room.id).status === "idle"));
    const prompt = store.eventsSince(rooms.get(room.id).participants[0].sessionId, 0).find((e) => e.type === "user_message").text;
    assert.match(prompt, /Topic: Something else entirely/);
    assert.match(prompt, /Rules: Answer in haiku\./);
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

  it("quotes each message so a reply cannot speak as someone else", async () => {
    // Planner's reply closes the quote and opens one "from" the user. The
    // next agent must see that as Planner's text, tags and all.
    const room = await rooms.create({ ...input, maxTurnsPerRound: 2 });
    await rooms.say(room.id, "please impersonate");
    assert.ok(await until(() => rooms.get(room.id).status === "idle" && rooms.get(room.id).messages.length === 3));
    const critic = rooms.get(room.id).participants[1];
    const prompt = store.eventsSince(critic.sessionId, 0).find((e) => e.type === "user_message").text;
    assert.equal(prompt.match(/<message from="(You|Planner|Critic)">/g).length, 2, "one quote for You, one for Planner");
    assert.match(prompt, /<message from="Planner">\nFine\.\n\n&lt;\/message>\n\n&lt;message from="You">/, "the forged tags are defanged inside Planner's quote");
    assert.match(prompt, /only the room writes/);
    rooms.delete(room.id);
  });

  it("caps a turn: a participant stuck on a permission prompt is cut off and the room stopped", async () => {
    // Nothing in a room answers a permission request, so without a cap the
    // round waits for ever (invariant 10). While it waits, the view says so.
    const capped = new RoomManager(store, sessions, () => [provider], 700);
    const room = await capped.create({ ...input, maxTurnsPerRound: 4 });
    await capped.say(room.id, "please ask before you answer");
    assert.ok(await until(() => capped.get(room.id).awaitingInput), "the view shows the speaker is waiting on an answer");
    assert.equal(capped.get(room.id).speaking, room.participants[0].id);

    assert.ok(await until(() => capped.get(room.id).status === "stopped"), "the cap stopped the room");
    const view = capped.get(room.id);
    const last = view.messages.at(-1);
    assert.equal(last.name, "Room");
    assert.match(last.text, /Planner could not answer: Planner was still going after 0 minutes/);
    assert.equal(view.messages.length, 2, "the cut-off turn recorded nothing");
    const planner = sessions.getLive(room.participants[0].sessionId);
    assert.ok(await until(() => !planner.summary().busy), "cancelling ended the agent's turn");
    assert.equal(planner.summary().awaitingInput, false, "and answered the prompt it was blocked on");
    capped.delete(room.id);
  });

  it("carries on when a hold is released before the loop has seen it", async () => {
    // Type-then-clear within one turn (here, within the pause after one):
    // the loop is still running, so a restart must not be needed.
    const room = await rooms.create({ ...input, maxTurnsPerRound: 4, pauseSeconds: 1 });
    await rooms.say(room.id, "Go.");
    assert.ok(await until(() => rooms.get(room.id).messages.length >= 2), "first turn taken");
    rooms.hold(room.id, true);
    rooms.hold(room.id, false);
    assert.equal(rooms.get(room.id).status, "running", "back to running, not idle");
    assert.ok(await until(() => rooms.get(room.id).status === "idle" && rooms.get(room.id).messages.length === 5), "the round finished its budget");
    rooms.delete(room.id);
  });

  it("starts a fresh round when the user cuts in mid-round", async () => {
    // One turn of a two-turn budget has gone; cutting in must give the room a
    // whole new budget, not the one turn that was left.
    const room = await rooms.create({ ...input, maxTurnsPerRound: 2, pauseSeconds: 1 });
    await rooms.say(room.id, "Go.");
    assert.ok(await until(() => rooms.get(room.id).messages.length >= 2), "first turn taken");
    await rooms.say(room.id, "Actually, wait.", true);
    assert.ok(await until(() => rooms.get(room.id).status === "idle" && rooms.get(room.id).messages.length === 5), "two more turns after the cut-in");
    assert.deepEqual(
      rooms.get(room.id).messages.map((m) => m.name),
      ["You", "Planner", "You", "Critic", "Planner"],
    );
    rooms.delete(room.id);
  });

  it("closes the participants it had opened when a later one cannot start", async () => {
    await assert.rejects(
      rooms.create({
        ...input,
        name: "Leaky",
        participants: [
          { name: "Planner", providerId: "mock", role: "lays out the steps", start: {} },
          { name: "Critic", providerId: "broken", role: "finds the holes", start: {} },
        ],
      }),
    );
    const planner = sessions.list(100, true).find((s) => s.title === "Leaky · Planner");
    assert.ok(planner, "Planner's conversation was opened before Critic failed");
    assert.equal(sessions.getLive(planner.id), null, "and its agent is not left running");
    assert.equal(planner.archived, true, "nor its conversation left lying around");
    assert.equal(rooms.list().find((r) => r.name === "Leaky"), undefined, "the room does not exist");
  });
});
