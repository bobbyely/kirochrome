// The scheduler against the mock agent: a run is an ordinary conversation,
// and what could not become one is still recorded.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "..", "..", "..", "spike", "mock-agent.mjs");
const provider = { id: "mock", name: "Mock", command: process.execPath, args: [MOCK] };

let Store, SessionManager, Scheduler, nextClockRun, dir, store, sessions, scheduler;

const input = {
  name: "Nightly",
  providerId: "mock",
  cwd: "/tmp",
  prompt: "hello",
  everyMinutes: 30,
  at: null,
  weekdaysOnly: false,
  keepRuns: 20,
  autoApprove: true,
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-scheduler-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: [provider] }));
  ({ Store } = await import("../dist/store.js"));
  ({ SessionManager } = await import("../dist/sessionManager.js"));
  ({ Scheduler, nextClockRun } = await import("../dist/scheduler.js"));
  store = new Store(join(dir, "test.db"));
  sessions = new SessionManager(store);
  scheduler = new Scheduler(store, sessions, () => [provider]);
  // Invariant 11: a schedule may only name a provider that has passed its check.
  store.saveCheck({ providerId: "mock", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });
});
after(() => {
  scheduler?.stop();
  sessions?.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("a schedule", () => {
  it("refuses bad input field by field, as a typed error", () => {
    assert.throws(
      () => scheduler.create({ ...input, name: " ", everyMinutes: 0, providerId: "nope" }),
      (err) =>
        err.code === "SCHEDULE_INVALID" &&
        /name is required/.test(err.message) &&
        /interval/.test(err.message) &&
        /no provider 'nope'/.test(err.message),
    );
  });

  it("refuses a provider that has not passed its check", () => {
    store.markStale("mock");
    assert.throws(() => scheduler.create(input), (err) => /setup check/.test(err.message));
    store.saveCheck({ providerId: "mock", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });
  });

  it("runs as a conversation tagged with the schedule, then detaches the agent", async () => {
    const schedule = scheduler.create(input);
    const run = await scheduler.runNow(schedule.id);

    assert.equal(run.outcome, "ok");
    assert.ok(run.sessionId, "the run became a conversation");
    assert.ok(run.endedAt >= run.startedAt);

    const record = store.getSession(run.sessionId);
    assert.equal(record.scheduleId, schedule.id, "the conversation knows its schedule");
    assert.match(record.title, /^Nightly · /, "named after the schedule, not the prompt");
    assert.ok(record.titleLocked, "and the agent cannot rename it");
    assert.equal(sessions.getLive(run.sessionId), null, "no agent left attached");

    const types = store.eventsSince(run.sessionId, 0).map((e) => e.type);
    assert.ok(types.includes("user_message") && types.includes("turn_end"), `turn recorded: ${types}`);

    const [view] = scheduler.list();
    assert.equal(view.runs[0].id, run.id);
    assert.equal(view.nextRunAt, run.startedAt + 30 * 60_000, "the next run counts from this one");
  });

  it("records a run that could not start, with the error", async () => {
    const schedule = scheduler.create({ ...input, providerId: "mock" });
    store.markStale("mock");
    const run = await scheduler.runNow(schedule.id);
    store.saveCheck({ providerId: "mock", status: "ok", stage: "capabilities", stages: [], checkedAt: Date.now() });

    assert.equal(run.outcome, "failed");
    assert.equal(run.sessionId, null);
    assert.equal(run.error.code, "AGENT_SESSION_FAILED");
  });

  it("pauses, resumes and deletes", async () => {
    const schedule = scheduler.create(input);
    assert.equal(scheduler.update(schedule.id, { status: "paused" }).status, "paused");
    assert.equal(scheduler.list().find((s) => s.id === schedule.id).nextRunAt, null);
    assert.equal(scheduler.update(schedule.id, { status: "active", everyMinutes: 5 }).everyMinutes, 5);
    scheduler.delete(schedule.id);
    await assert.rejects(scheduler.runNow(schedule.id), (err) => err.code === "SCHEDULE_UNKNOWN");
  });

  it("is unread until its conversation is opened", async () => {
    const schedule = scheduler.create(input);
    const run = await scheduler.runNow(schedule.id);
    const latest = () => scheduler.list(schedule.id)[0].runs[0];
    assert.equal(latest().unread, true);
    sessions.markRead(run.sessionId);
    assert.equal(latest().unread, false);
  });

  it("archives conversations beyond the runs it keeps, and keeps every row", async () => {
    const schedule = scheduler.create({ ...input, keepRuns: 1 });
    const first = await scheduler.runNow(schedule.id);
    const second = await scheduler.runNow(schedule.id);
    assert.equal(store.getSession(first.sessionId).status, "archived");
    assert.equal(store.getSession(second.sessionId).status, "active");
    assert.equal(store.listRuns(schedule.id).length, 2);
  });

  it("runs at a clock time, next day after the last run, skipping weekends when asked", () => {
    // Friday 2026-09-11 08:00 local.
    const friday = new Date(2026, 8, 11, 8, 0).getTime();
    assert.equal(nextClockRun("09:00", false, friday), new Date(2026, 8, 11, 9, 0).getTime());
    const fridayNine = new Date(2026, 8, 11, 9, 0, 30).getTime();
    assert.equal(nextClockRun("09:00", false, fridayNine), new Date(2026, 8, 12, 9, 0).getTime());
    assert.equal(nextClockRun("09:00", true, fridayNine), new Date(2026, 8, 14, 9, 0).getTime(), "Monday");
    const daily = scheduler.create({ ...input, at: "09:00", weekdaysOnly: true });
    assert.ok(scheduler.list().find((s) => s.id === daily.id).nextRunAt > Date.now());
    assert.throws(() => scheduler.create({ ...input, at: "25:00" }), (err) => /HH:MM/.test(err.message));
  });

  it("closes runs the previous server left in flight", () => {
    const schedule = scheduler.create(input);
    store.upsertRun({
      id: "orphan",
      scheduleId: schedule.id,
      startedAt: Date.now() - 1000,
      endedAt: null,
      sessionId: null,
      outcome: "running",
      error: null,
      message: null,
      unread: true,
    });
    new Scheduler(store, sessions, () => [provider]).start();
    const [run] = store.listRuns(schedule.id);
    assert.equal(run.id, "orphan");
    assert.equal(run.outcome, "failed");
    assert.equal(run.error.code, "AGENT_EXITED");
  });
});
