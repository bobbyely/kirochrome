import { randomUUID } from "node:crypto";
import {
  kcError,
  SCHEDULE_MAX_KEEP,
  SCHEDULE_MAX_MINUTES,
  SCHEDULE_MIN_KEEP,
  SCHEDULE_MIN_MINUTES,
  type KcError,
  type ProviderConfig,
  type Schedule,
  type ScheduleInput,
  type ScheduleRun,
  type ScheduleView,
} from "@kirochrome/shared";
import type { SessionManager } from "./sessionManager.js";
import type { Store } from "./store.js";
import { withTimeout } from "./timeout.js";

/** How often the timer asks what is due. Schedules are in minutes, so this is enough. */
const TICK_MS = 60_000;
/** A run that has not ended by then is killed, whatever it is doing. */
const RUN_CAP_MS = 60 * 60_000;

/**
 * Runs saved prompts on a timer, each as an ordinary conversation.
 *
 * The server owns turns (invariant 4), so nothing here needs a browser: a run
 * is `open` → `prompt` → wait for the turn → detach the agent. What the
 * schedule adds is the record of *when* it fired and *whether* it got as far
 * as a conversation, because a run that could not start has no transcript to
 * be found in.
 *
 * Timers live in this process and nowhere else. A restart recomputes the next
 * run from the last row in `schedule_runs`, and the run that was in flight is
 * over — its agent died with the server.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  /** Schedules with a run in flight, so a slow run is skipped rather than doubled. */
  private readonly running = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly providers: () => ProviderConfig[],
  ) {}

  start(): void {
    const orphaned = this.store.failOrphanRuns(
      kcError("AGENT_EXITED", "The server restarted while this run was in progress.", {
        remediation: "Open the conversation to see how far it got; the next run is unaffected.",
      }),
    );
    if (orphaned > 0) console.log(`Closed ${orphaned} scheduled run(s) left over from the previous server.`);

    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Never the reason the process stays up: shutdown closes sessions, not timers.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- the schedule list ----------

  list(): ScheduleView[] {
    return this.store.listSchedules().map((schedule) => ({
      ...schedule,
      runs: this.store.listRuns(schedule.id),
      nextRunAt: this.nextRunAt(schedule),
    }));
  }

  create(input: ScheduleInput): Schedule {
    const now = Date.now();
    const schedule: Schedule = { ...this.validate(input), id: randomUUID(), status: "active", createdAt: now, updatedAt: now };
    this.store.upsertSchedule(schedule);
    return schedule;
  }

  update(id: string, patch: Partial<ScheduleInput> & { status?: Schedule["status"] }): Schedule {
    const existing = this.require(id);
    const { status, ...fields } = patch;
    const schedule: Schedule = {
      ...existing,
      ...this.validate({ ...existing, ...fields }),
      status: status ?? existing.status,
      updatedAt: Date.now(),
    };
    this.store.upsertSchedule(schedule);
    return schedule;
  }

  delete(id: string): void {
    this.require(id);
    this.store.deleteSchedule(id);
  }

  /** Fires a schedule now. Counts as its last run, so the timer waits a full interval after it. */
  async runNow(id: string): Promise<ScheduleRun> {
    return this.run(this.require(id));
  }

  private require(id: string): Schedule {
    const schedule = this.store.getSchedule(id);
    if (!schedule) throw kcError("SCHEDULE_UNKNOWN", `No schedule '${id}'.`);
    return schedule;
  }

  /**
   * Field-by-field, like the other boundary that is not ours (`config.json`):
   * this comes from a browser form, and a bad interval or an unverified
   * provider must be refused here rather than discovered at 3am.
   */
  private validate(input: ScheduleInput): ScheduleInput {
    const problems: string[] = [];
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    const everyMinutes = Number(input.everyMinutes);
    const at = typeof input.at === "string" && input.at.trim() ? input.at.trim() : null;
    const keepRuns = Number(input.keepRuns);

    if (!name) problems.push("a name is required");
    if (!prompt) problems.push("a prompt is required");
    if (!cwd) problems.push("a working directory is required");
    if (at !== null && parseClock(at) === null) problems.push("the time must be HH:MM");
    if (at === null && (!Number.isInteger(everyMinutes) || everyMinutes < SCHEDULE_MIN_MINUTES || everyMinutes > SCHEDULE_MAX_MINUTES)) {
      problems.push(`the interval must be a whole number of minutes from ${SCHEDULE_MIN_MINUTES} to ${SCHEDULE_MAX_MINUTES}`);
    }
    if (!Number.isInteger(keepRuns) || keepRuns < SCHEDULE_MIN_KEEP || keepRuns > SCHEDULE_MAX_KEEP) {
      problems.push(`runs to keep must be a whole number from ${SCHEDULE_MIN_KEEP} to ${SCHEDULE_MAX_KEEP}`);
    }
    const provider = this.providers().find((p) => p.id === input.providerId);
    if (!provider) problems.push(`no provider '${String(input.providerId)}'`);
    else if (this.store.lastCheck(provider.id)?.status !== "ok") {
      problems.push(`'${provider.name}' has not passed its setup check`);
    }

    if (problems.length > 0) {
      throw kcError("SCHEDULE_INVALID", `The schedule is not valid: ${problems.join("; ")}.`);
    }
    return {
      name,
      prompt,
      cwd,
      // Unused while `at` is set, but kept so switching back does not lose it.
      everyMinutes: at === null || (Number.isInteger(everyMinutes) && everyMinutes >= SCHEDULE_MIN_MINUTES) ? everyMinutes : 60,
      at,
      weekdaysOnly: at !== null && input.weekdaysOnly === true,
      keepRuns,
      providerId: input.providerId,
      autoApprove: input.autoApprove === true,
    };
  }

  // ---------- firing ----------

  private nextRunAt(schedule: Schedule): number | null {
    if (schedule.status !== "active") return null;
    const last = this.store.lastRunStartedAt(schedule.id) ?? schedule.updatedAt;
    if (schedule.at === null) return last + schedule.everyMinutes * 60_000;
    return nextClockRun(schedule.at, schedule.weekdaysOnly, last);
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const schedule of this.store.listSchedules()) {
      const due = this.nextRunAt(schedule);
      if (due === null || due > now) continue;
      await this.run(schedule);
    }
  }

  private async run(schedule: Schedule): Promise<ScheduleRun> {
    const run: ScheduleRun = {
      id: randomUUID(),
      scheduleId: schedule.id,
      startedAt: Date.now(),
      endedAt: null,
      sessionId: null,
      outcome: "running",
      error: null,
      message: null,
      unread: true,
    };

    if (this.running.has(schedule.id)) {
      return this.finish(run, { outcome: "skipped", message: "The previous run was still going." });
    }

    // Invariant 11: the provider must have passed its check. The chat UI only
    // offers ones that have; nothing stands between a timer and this call.
    const provider = this.providers().find((p) => p.id === schedule.providerId);
    if (!provider) {
      return this.finish(run, {
        outcome: "failed",
        error: kcError("PROVIDER_UNKNOWN", `No provider configured with id '${schedule.providerId}'.`),
      });
    }
    if (this.store.lastCheck(provider.id)?.status !== "ok") {
      return this.finish(run, {
        outcome: "failed",
        error: kcError("AGENT_SESSION_FAILED", `'${provider.name}' has not passed its setup check.`, {
          remediation: "Re-run the check on the setup page, then the next run will go ahead.",
        }),
      });
    }

    this.running.add(schedule.id);
    this.store.upsertRun(run);
    try {
      const session = await this.sessions.open(provider, schedule.cwd);
      session.tagSchedule(schedule.id, runTitle(schedule, run.startedAt));
      session.setAutoApprove(schedule.autoApprove);
      run.sessionId = session.id;
      this.store.upsertRun(run);

      try {
        await withTimeout(session.prompt(schedule.prompt), RUN_CAP_MS, () =>
          kcError("RPC_TIMEOUT", `The run was still going after ${RUN_CAP_MS / 60_000} minutes and was stopped.`, {
            remediation: "Make the prompt finish sooner, or split it. The transcript shows where it got to.",
          }),
        );
      } finally {
        // The agent is done with, whatever happened. The transcript stays, and
        // 'Resume conversation' brings an agent back if you want to follow up.
        this.sessions.detach(session.id);
      }

      // `prompt` reports failure as an event rather than a throw, so the log
      // says how the turn ended.
      const failure = lastFailure(session.eventsSince(0));
      return this.finish(run, failure ? { outcome: "failed", error: failure } : { outcome: "ok" });
    } catch (err) {
      const error = isKcError(err) ? err : kcError("INTERNAL", "The run failed.", { cause: String(err) });
      return this.finish(run, { outcome: "failed", error });
    } finally {
      this.running.delete(schedule.id);
      this.prune(schedule);
    }
  }

  /**
   * Keeps the newest `keepRuns` conversations; older ones are archived, not
   * deleted — the log is append-only, and the run rows stay for the history.
   */
  private prune(schedule: Schedule): void {
    for (const run of this.store.runsBeyond(schedule.id, schedule.keepRuns)) {
      if (!run.sessionId) continue;
      const record = this.store.getSession(run.sessionId);
      if (record && record.status !== "archived") this.sessions.setArchived(run.sessionId, true);
    }
  }

  private finish(
    run: ScheduleRun,
    end: { outcome: ScheduleRun["outcome"]; error?: KcError; message?: string },
  ): ScheduleRun {
    const finished: ScheduleRun = {
      ...run,
      endedAt: Date.now(),
      outcome: end.outcome,
      error: end.error ?? null,
      message: end.message ?? null,
    };
    this.store.upsertRun(finished);
    return finished;
  }
}

/** The error that ended the last turn, if the turn did not end cleanly. */
function lastFailure(events: ReadonlyArray<{ type: string; error?: KcError }>): KcError | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "turn_end") return null;
    if (event.type === "error" && event.error) return event.error;
  }
  return null;
}

/** "Nightly review · Fri 09:00" — what a run is called in the sidebar. */
function runTitle(schedule: Schedule, startedAt: number): string {
  const when = new Date(startedAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${schedule.name} · ${when}`;
}

/** "HH:MM" → [hours, minutes], or null when it is not a clock time. */
export function parseClock(at: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return [hours, minutes];
}

/**
 * The first occurrence of the clock time after `after`, in local time.
 * Skips weekends when asked. `after` is the last run, so a run that fired at
 * 09:00 is not due again until 09:00 tomorrow even if the server checks at
 * 09:00:30.
 */
export function nextClockRun(at: string, weekdaysOnly: boolean, after: number): number {
  const clock = parseClock(at);
  if (!clock) return Number.POSITIVE_INFINITY;
  const [hours, minutes] = clock;
  const candidate = new Date(after);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() <= after) candidate.setDate(candidate.getDate() + 1);
  while (weekdaysOnly && (candidate.getDay() === 0 || candidate.getDay() === 6)) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

const isKcError = (err: unknown): err is KcError =>
  typeof err === "object" && err !== null && "code" in err && "message" in err;
