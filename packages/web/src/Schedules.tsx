import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  SCHEDULE_DEFAULT_KEEP,
  SCHEDULE_MAX_KEEP,
  SCHEDULE_MAX_MINUTES,
  SCHEDULE_MIN_KEEP,
  SCHEDULE_MIN_MINUTES,
} from "@kirochrome/shared";
import type { ProviderView, ScheduleInput, ScheduleRun, ScheduleView } from "@kirochrome/shared";
import {
  ApiError,
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  runSchedule,
  updateSchedule,
} from "./api.js";
import { useReadyProviders } from "./useReadyProviders.js";
import { chosen, StartPickers } from "./StartPickers.js";
import { useChat } from "./useChat.js";

const EMPTY: ScheduleInput = {
  name: "",
  providerId: "",
  cwd: "",
  prompt: "",
  everyMinutes: 30,
  at: null,
  weekdaysOnly: false,
  keepRuns: SCHEDULE_DEFAULT_KEEP,
  autoApprove: false,
  start: {},
};

/**
 * Prompts the server runs on a timer. Each run is a conversation in the
 * sidebar; this page is the view across runs — when each fired, how it ended,
 * and the ones that never got as far as a conversation.
 */
export function Schedules({
  onOpenSession,
  onOpenSchedule,
}: {
  onOpenSession: (id: string) => void;
  onOpenSchedule: (id: string) => void;
}) {
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const { providers, error: providerError } = useReadyProviders();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduleView | "new" | null>(null);
  const { connected, workspaces, listWorkspaces } = useChat();

  const refresh = useCallback(async () => {
    try {
      const s = await fetchSchedules();
      setSchedules(s.schedules);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.kc.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (connected) listWorkspaces();
  }, [connected, listWorkspaces]);
  // Runs end on their own clock; a page left open should notice.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.kc.message : String(err));
    }
  };

  if ((error && !schedules) || providerError) return <div className="page"><div className="banner">{providerError ?? error}</div></div>;
  if (!schedules || !providers) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <header className="header">
        <h1>Schedules</h1>
        <p className="subtitle">
          A prompt the server runs on its own, every so often. Each run is an ordinary conversation;
          the server has to be running, the browser does not.
        </p>
      </header>

      {error && <div className="banner">{error}</div>}

      {editing ? (
        <ScheduleForm
          initial={editing === "new" ? EMPTY : editing}
          providers={providers}
          workspaces={workspaces ?? []}
          onCancel={() => setEditing(null)}
          onSave={(input) =>
            act(async () => {
              if (editing === "new") await createSchedule(input);
              else await updateSchedule(editing.id, input);
              setEditing(null);
            })
          }
        />
      ) : (
        <button className="primary" onClick={() => setEditing("new")} disabled={providers.length === 0}>
          New schedule
        </button>
      )}
      {providers.length === 0 && (
        <p className="field-hint">No provider has passed its setup check yet, so there is nothing to run.</p>
      )}

      {schedules.map((schedule) => (
        <section className="schedule" key={schedule.id}>
          <div className="schedule-head">
            <div className="schedule-title">
              <button className="schedule-name" onClick={() => onOpenSchedule(schedule.id)}>
                {schedule.name}
              </button>
              <span className="muted">
                {cadence(schedule)} · {providerName(providers, schedule.providerId)} ·{" "}
                <code className="cmd">{schedule.cwd}</code> · keeps {schedule.keepRuns}
              </span>
            </div>
            <span className={`pill ${schedule.status === "active" ? "pill-ok" : ""}`}>
              {schedule.status === "active" ? `next ${relative(schedule.nextRunAt)}` : "paused"}
            </span>
          </div>
          <pre className="schedule-prompt">{schedule.prompt}</pre>
          <div className="schedule-actions">
            <button onClick={() => act(() => runSchedule(schedule.id))}>Run now</button>
            <button
              onClick={() =>
                act(() => updateSchedule(schedule.id, { status: schedule.status === "active" ? "paused" : "active" }))
              }
            >
              {schedule.status === "active" ? "Pause" : "Resume"}
            </button>
            <button onClick={() => setEditing(schedule)}>Edit</button>
            <button onClick={() => act(() => deleteSchedule(schedule.id))}>Delete</button>
          </div>
          <RunList runs={schedule.runs.slice(0, 3)} onOpenSession={onOpenSession} />
          {schedule.runs.length > 3 && (
            <button className="schedule-more" onClick={() => onOpenSchedule(schedule.id)}>
              All runs →
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * One schedule's log: every run, newest first. This is the one place a
 * schedule's conversations are listed — they stay out of the sidebar, since
 * forty-eight a day of the same prompt would say nothing there.
 */
export function ScheduleLog({
  scheduleId,
  onOpenSession,
  onBack,
}: {
  scheduleId: string;
  onOpenSession: (id: string) => void;
  onBack: () => void;
}) {
  const [schedule, setSchedule] = useState<ScheduleView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { schedules } = await fetchSchedules(scheduleId);
      setSchedule(schedules.find((s) => s.id === scheduleId) ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.kc.message : String(err));
    }
  }, [scheduleId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.kc.message : String(err));
    }
  };

  if (schedule === undefined) return <div className="page"><p className="muted">Loading…</p></div>;
  if (schedule === null) {
    return (
      <div className="page">
        <div className="banner">That schedule no longer exists.</div>
        <button onClick={onBack}>All schedules</button>
      </div>
    );
  }

  return (
    <div className="page">
      <button className="backlink" onClick={onBack}>
        ← All schedules
      </button>
      <header className="header">
        <h1>{schedule.name}</h1>
        <p className="subtitle">
          {cadence(schedule)} · <code className="cmd">{schedule.cwd}</code> ·{" "}
          {schedule.status === "active" ? `next ${relative(schedule.nextRunAt)}` : "paused"}
        </p>
      </header>
      {error && <div className="banner">{error}</div>}
      <pre className="schedule-prompt">{schedule.prompt}</pre>
      <div className="schedule-actions">
        <button onClick={() => act(() => runSchedule(schedule.id))}>Run now</button>
        <button
          onClick={() =>
            act(() => updateSchedule(schedule.id, { status: schedule.status === "active" ? "paused" : "active" }))
          }
        >
          {schedule.status === "active" ? "Pause" : "Resume"}
        </button>
      </div>
      <RunList runs={schedule.runs} onOpenSession={onOpenSession} />
    </div>
  );
}

function ScheduleForm({
  initial,
  providers,
  workspaces,
  onSave,
  onCancel,
}: {
  initial: ScheduleInput;
  providers: ProviderView[];
  workspaces: string[];
  onSave: (input: ScheduleInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ScheduleInput>({
    ...initial,
    providerId: initial.providerId || (providers[0]?.id ?? ""),
    cwd: initial.cwd || (workspaces[0] ?? ""),
  });
  const set = <K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const provider = providers.find((p) => p.id === form.providerId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ ...form, start: chosen(provider, form.start) });
  };

  return (
    <form className="schedule-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Name</span>
        <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Nightly review" />
      </label>

      <label className="field">
        <span className="field-label">Provider</span>
        <select
          value={form.providerId}
          onChange={(e) => setForm((f) => ({ ...f, providerId: e.target.value, start: {} }))}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="field-label">Settings for each run</span>
        <StartPickers provider={provider} value={form.start} onChange={(start) => set("start", start)} />
      </div>

      <label className="field">
        <span className="field-label">Working directory</span>
        <input value={form.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="/path/to/project" spellCheck={false} />
      </label>
      {workspaces.length > 0 && (
        <div className="chips">
          {workspaces.map((w) => (
            <button type="button" key={w} className={`chip ${w === form.cwd ? "chip-on" : ""}`} onClick={() => set("cwd", w)}>
              {w}
            </button>
          ))}
        </div>
      )}

      <label className="field">
        <span className="field-label">Prompt</span>
        <textarea
          value={form.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={5}
          placeholder="Check CI on main. If it is red, find the failing job and say why in three lines."
        />
        <span className="field-hint">
          The first message of each run. Say what to do with what it finds — nobody is typing the
          follow-up. Slash commands work.
        </span>
      </label>

      <div className="field">
        <span className="field-label">When</span>
        <div className="schedule-when">
          <label className="schedule-radio">
            <input type="radio" checked={form.at === null} onChange={() => set("at", null)} />
            <span>every</span>
            <input
              type="number"
              min={SCHEDULE_MIN_MINUTES}
              max={SCHEDULE_MAX_MINUTES}
              value={form.everyMinutes}
              disabled={form.at !== null}
              onChange={(e) => set("everyMinutes", Number(e.target.value))}
            />
            <span>minutes</span>
          </label>
          <label className="schedule-radio">
            <input type="radio" checked={form.at !== null} onChange={() => set("at", form.at ?? "09:00")} />
            <span>daily at</span>
            <input type="time" value={form.at ?? "09:00"} disabled={form.at === null} onChange={(e) => set("at", e.target.value)} />
            <label className="schedule-inline">
              <input
                type="checkbox"
                checked={form.weekdaysOnly}
                disabled={form.at === null}
                onChange={(e) => set("weekdaysOnly", e.target.checked)}
              />
              weekdays only
            </label>
          </label>
        </div>
      </div>

      <label className="field">
        <span className="field-label">Runs to keep</span>
        <input
          type="number"
          min={SCHEDULE_MIN_KEEP}
          max={SCHEDULE_MAX_KEEP}
          value={form.keepRuns}
          onChange={(e) => set("keepRuns", Number(e.target.value))}
        />
        <span className="field-hint">Older runs are archived, not deleted; the history below keeps every row.</span>
      </label>

      <label className="field schedule-check">
        <input type="checkbox" checked={form.autoApprove} onChange={(e) => set("autoApprove", e.target.checked)} />
        <span>Allow the agent&rsquo;s permission requests automatically</span>
        <span className="field-hint">
          Nobody is watching, so without this the first permission prompt parks the run until it is
          stopped. With it, the agent can edit files and run commands unattended.
        </span>
      </label>

      <div className="schedule-actions">
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RunList({ runs, onOpenSession }: { runs: ScheduleRun[]; onOpenSession: (id: string) => void }) {
  if (runs.length === 0) return <p className="field-hint">No runs yet.</p>;
  return (
    <ul className="runs">
      {runs.map((run) => {
        const sessionId = run.sessionId;
        return (
        <li className={`run run-${run.outcome}`} key={run.id}>
          <span className="run-mark" aria-hidden="true">
            {MARK[run.outcome]}
          </span>
          <span className="run-when">{new Date(run.startedAt).toLocaleString()}</span>
          <span className="run-outcome">{run.outcome}</span>
          <span className="run-detail muted">
            {run.endedAt !== null && `${duration(run.endedAt - run.startedAt)} `}
            {run.error?.message ?? run.message}
          </span>
          {sessionId && (
            <button className="run-open" onClick={() => onOpenSession(sessionId)}>
              Open
            </button>
          )}
        </li>
        );
      })}
    </ul>
  );
}

const MARK: Record<ScheduleRun["outcome"], string> = { running: "◐", ok: "✓", failed: "✗", skipped: "–" };

const providerName = (providers: ProviderView[], id: string) => providers.find((p) => p.id === id)?.name ?? id;

function cadence(schedule: ScheduleView): string {
  if (schedule.at === null) return `every ${minutes(schedule.everyMinutes)}`;
  return `${schedule.weekdaysOnly ? "weekdays" : "daily"} at ${schedule.at}`;
}

function minutes(n: number): string {
  if (n % 1440 === 0) return `${n / 1440}d`;
  if (n % 60 === 0) return `${n / 60}h`;
  return `${n}m`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function relative(at: number | null): string {
  if (at === null) return "—";
  const m = Math.round((at - Date.now()) / 60_000);
  if (m <= 0) return "any minute";
  if (m < 60) return `in ${m}m`;
  if (m < 24 * 60) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
