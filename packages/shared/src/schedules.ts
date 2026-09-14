import type { KcError } from "./errors.js";
import type { StartOptions } from "./events.js";

/**
 * A prompt the server runs on its own, on an interval. Each firing is an
 * ordinary conversation: the schedule only decides when one starts and what
 * its first message is.
 */
export interface Schedule {
  id: string;
  name: string;
  providerId: string;
  cwd: string;
  prompt: string;
  /**
   * Minutes between runs, counted from the start of the previous one — or,
   * when `at` is set, ignored: the run is at that clock time instead.
   */
  everyMinutes: number;
  /** "HH:MM" local time for a daily run, or null to run on the interval. */
  at: string | null;
  /** With `at`: skip Saturday and Sunday. */
  weekdaysOnly: boolean;
  /** Runs to keep per schedule; older conversations are archived. */
  keepRuns: number;
  /**
   * Answer the agent's permission prompts with the first "allow" option.
   * Nobody is watching a scheduled run, so without this the first prompt
   * parks it until the cap kills it.
   */
  autoApprove: boolean;
  /** Model, mode and an opening message for each run's session. */
  start: StartOptions;
  status: "active" | "paused";
  createdAt: number;
  updatedAt: number;
}

/** What a client may send to create or change a schedule. */
export type ScheduleInput = Pick<
  Schedule,
  "name" | "providerId" | "cwd" | "prompt" | "everyMinutes" | "at" | "weekdaysOnly" | "keepRuns" | "autoApprove" | "start"
>;

export const SCHEDULE_MIN_MINUTES = 1;
export const SCHEDULE_MAX_MINUTES = 7 * 24 * 60;
export const SCHEDULE_MIN_KEEP = 1;
export const SCHEDULE_MAX_KEEP = 500;
export const SCHEDULE_DEFAULT_KEEP = 20;

/**
 * One firing. A run that never became a conversation — the agent would not
 * start, or the previous run was still going — has nowhere else to be seen,
 * so it is recorded here with why.
 */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  startedAt: number;
  endedAt: number | null;
  /** The conversation it ran as, once the agent was up. */
  sessionId: string | null;
  outcome: "running" | "ok" | "failed" | "skipped";
  /** True until someone opens the conversation, so a run that needs a look stands out. */
  unread: boolean;
  /** Set for `failed`; `skipped` carries its reason in `message`. */
  error: KcError | null;
  message: string | null;
}

export interface ScheduleView extends Schedule {
  runs: ScheduleRun[];
  /** When the next firing is due, or null while paused. */
  nextRunAt: number | null;
}

export interface SchedulesResponse {
  schedules: ScheduleView[];
}
