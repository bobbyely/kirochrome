import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ROOM_DEFAULT_PAUSE,
  ROOM_DEFAULT_RULES,
  ROOM_DEFAULT_TURNS,
  ROOM_MAX_PARTICIPANTS,
  ROOM_MAX_TURNS,
  ROOM_USER,
} from "@kirochrome/shared";
import type { ProviderView, RoomInput, RoomView } from "@kirochrome/shared";
import { ApiError, createRoom, deleteRoom, fetchProviders, fetchRoom, fetchRooms, roomVerb } from "./api.js";
import { KSpinner } from "./KSpinner.js";
import { MarkdownBody } from "./Markdown.js";
import { chosen, StartPickers } from "./StartPickers.js";
import { useChat } from "./useChat.js";

const EMPTY: RoomInput = {
  name: "",
  cwd: "",
  topic: "",
  rules: ROOM_DEFAULT_RULES,
  maxTurnsPerRound: ROOM_DEFAULT_TURNS,
  pauseSeconds: ROOM_DEFAULT_PAUSE,
  creditCap: null,
  participants: [
    { name: "Planner", providerId: "", role: "lays out the steps and owns the plan", start: {} },
    { name: "Critic", providerId: "", role: "finds what is missing or wrong, and says so briefly", start: {} },
  ],
};

const describe = (err: unknown) => (err instanceof ApiError ? err.kc.message : String(err));

/** The list of rooms, and the form for a new one. */
export function Rooms({ onOpenRoom }: { onOpenRoom: (id: string) => void }) {
  const [rooms, setRooms] = useState<RoomView[] | null>(null);
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const { connected, workspaces, listWorkspaces } = useChat();

  const refresh = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([fetchRooms(), fetchProviders()]);
      setRooms(r.rooms);
      setProviders(p.providers.filter((v) => v.lastCheck?.status === "ok"));
      setError(null);
    } catch (err) {
      setError(describe(err));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (connected) listWorkspaces();
  }, [connected, listWorkspaces]);

  if (error && !rooms) return <div className="page"><div className="banner">{error}</div></div>;
  if (!rooms || !providers) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <header className="header">
        <h1>Rooms</h1>
        <p className="subtitle">
          Two or more agents and you, talking in turns. Give each a name and a role, set a topic, and
          say something to start a round. Typing holds the room; Stop ends it.
        </p>
      </header>
      {error && <div className="banner">{error}</div>}

      {creating ? (
        <RoomForm
          providers={providers}
          workspaces={workspaces ?? []}
          pending={pending}
          onCancel={() => setCreating(false)}
          onSave={async (input) => {
            // Creating spawns an agent per participant, which takes seconds;
            // without this the button invited a second and third room.
            if (pending) return;
            setPending(true);
            try {
              const { room } = await createRoom(input);
              setCreating(false);
              onOpenRoom(room.id);
            } catch (err) {
              setError(describe(err));
            } finally {
              setPending(false);
            }
          }}
        />
      ) : (
        <button className="primary" onClick={() => setCreating(true)} disabled={providers.length === 0}>
          New room
        </button>
      )}
      {providers.length === 0 && (
        <p className="field-hint">No provider has passed its setup check yet, so there is nobody to invite.</p>
      )}

      {rooms.map((room) => (
        <section className="schedule" key={room.id}>
          <div className="schedule-head">
            <div className="schedule-title">
              <button className="schedule-name" onClick={() => onOpenRoom(room.id)}>
                {room.name}
              </button>
              <span className="muted">
                {room.participants.map((p) => p.name).join(", ")} · {room.messages.length} messages ·{" "}
                {room.creditsUsed.toFixed(2)} cr
              </span>
            </div>
            <span className={`pill ${room.status === "running" ? "pill-ok" : ""}`}>{room.status}</span>
          </div>
          <p className="room-topic">{room.topic}</p>
          <div className="schedule-actions">
            <button onClick={() => onOpenRoom(room.id)}>Open</button>
            <button
              onClick={async () => {
                await deleteRoom(room.id).catch((err) => setError(describe(err)));
                await refresh();
              }}
            >
              Delete
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}

function RoomForm({
  providers,
  workspaces,
  pending,
  onSave,
  onCancel,
}: {
  providers: ProviderView[];
  workspaces: string[];
  pending: boolean;
  onSave: (input: RoomInput) => void;
  onCancel: () => void;
}) {
  const defaultProvider = providers[0]?.id ?? "";
  const [form, setForm] = useState<RoomInput>({
    ...EMPTY,
    cwd: workspaces[0] ?? "",
    participants: EMPTY.participants.map((p) => ({ ...p, providerId: defaultProvider })),
  });
  const set = <K extends keyof RoomInput>(key: K, value: RoomInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setParticipant = (i: number, patch: Partial<RoomInput["participants"][number]>) =>
    setForm((f) => ({ ...f, participants: f.participants.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  const providerOf = (id: string) => providers.find((p) => p.id === id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({
      ...form,
      participants: form.participants.map((p) => ({ ...p, start: chosen(providerOf(p.providerId), p.start) })),
    });
  };

  return (
    <form className="schedule-form" onSubmit={submit}>
      <label className="field">
        <span className="field-label">Name</span>
        <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Planning the importer" />
      </label>
      <label className="field">
        <span className="field-label">Working directory</span>
        <input value={form.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="/path/to/project" spellCheck={false} />
        <span className="field-hint">Every participant reads this project.</span>
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
        <span className="field-label">Topic</span>
        <textarea
          value={form.topic}
          onChange={(e) => set("topic", e.target.value)}
          rows={3}
          placeholder="Plan how we add a CSV importer: scope, steps, risks, what to build first."
        />
        <span className="field-hint">Every participant sees this on every turn.</span>
      </label>
      <label className="field">
        <span className="field-label">Rules</span>
        <textarea value={form.rules} onChange={(e) => set("rules", e.target.value)} rows={4} />
        <span className="field-hint">
          How everyone should behave, after the topic in every prompt. Keep &ldquo;reply with exactly PASS&rdquo; if
          you want agents to be able to yield.
        </span>
      </label>

      <div className="field">
        <span className="field-label">Participants</span>
        {form.participants.map((p, i) => (
          <div className="room-participant-block" key={i}>
            <div className="room-participant">
              <input value={p.name} onChange={(e) => setParticipant(i, { name: e.target.value })} placeholder="Name" />
              <select
                value={p.providerId}
                onChange={(e) => setParticipant(i, { providerId: e.target.value, start: {} })}
              >
                {providers.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </select>
              <input value={p.role} onChange={(e) => setParticipant(i, { role: e.target.value })} placeholder="Role, one line" />
              <button
                type="button"
                disabled={form.participants.length <= 2}
                onClick={() => set("participants", form.participants.filter((_, j) => j !== i))}
                aria-label="Remove"
              >
                ×
              </button>
            </div>
            <StartPickers
              compact
              provider={providerOf(p.providerId)}
              value={p.start}
              onChange={(start) => setParticipant(i, { start })}
            />
          </div>
        ))}
        {form.participants.length < ROOM_MAX_PARTICIPANTS && (
          <button
            type="button"
            className="chip"
            onClick={() =>
              set("participants", [...form.participants, { name: "", providerId: defaultProvider, role: "", start: {} }])
            }
          >
            + participant
          </button>
        )}
      </div>

      <div className="room-numbers">
        <label className="field">
          <span className="field-label">Agent turns per round</span>
          <input type="number" min={1} max={ROOM_MAX_TURNS} value={form.maxTurnsPerRound} onChange={(e) => set("maxTurnsPerRound", Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">Pause between turns (s)</span>
          <input type="number" min={0} max={60} value={form.pauseSeconds} onChange={(e) => set("pauseSeconds", Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">Credit cap</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={form.creditCap ?? ""}
            onChange={(e) => set("creditCap", e.target.value === "" ? null : Number(e.target.value))}
            placeholder="none"
          />
        </label>
      </div>
      <p className="field-hint">
        A round is what one message from you sets off. Every agent turn re-reads what was said since its last one,
        so the turn budget is also the cost budget.
      </p>

      <div className="schedule-actions">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Starting the agents…" : "Create and open"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One room: the transcript, who is speaking, and a composer whose keystrokes
 * hold the room. Polled rather than pushed — a room's clock is agent turns,
 * seconds apart, and this keeps the socket protocol untouched.
 */
export function RoomView({
  roomId,
  onOpenSession,
  onBack,
}: {
  roomId: string;
  onOpenSession: (id: string) => void;
  onBack: () => void;
}) {
  const [room, setRoom] = useState<RoomView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const held = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setRoom((await fetchRoom(roomId)).room);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.kc.code === "ROOM_UNKNOWN") setRoom(null);
      else setError(describe(err));
    }
  }, [roomId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Faster while something is happening, slower when the room is quiet.
  useEffect(() => {
    const ms = room?.status === "running" || room?.status === "held" ? 1200 : 5000;
    const timer = setInterval(() => void refresh(), ms);
    return () => clearInterval(timer);
  }, [refresh, room?.status]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [room?.messages.length, room?.speakingText.length]);

  const [steering, setSteering] = useState<{ topic: string; rules: string } | null>(null);
  const verb = async (name: "say" | "hold" | "resume" | "stop" | "reconnect" | "steer", body?: unknown) => {
    try {
      setRoom((await roomVerb(roomId, name, body)).room);
      setError(null);
    } catch (err) {
      setError(describe(err));
    }
  };

  // The first keystroke holds the room; an emptied box releases it. Sending
  // releases it too, since the message is now the thing to respond to.
  const onDraft = (text: string) => {
    setDraft(text);
    const typing = text.trim().length > 0;
    if (typing !== held.current) {
      held.current = typing;
      void verb("hold", { held: typing });
    }
  };

  const send = async (cutIn: boolean) => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    held.current = false;
    await verb("say", { text, cutIn });
    setSending(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void send(e.metaKey || e.ctrlKey);
  };

  if (room === undefined) return <div className="page"><p className="muted">Loading…</p></div>;
  if (room === null) {
    return (
      <div className="page">
        <div className="banner">That room no longer exists.</div>
        <button onClick={onBack}>All rooms</button>
      </div>
    );
  }

  const speaking = room.participants.find((p) => p.id === room.speaking);
  const busy = room.status === "running" || room.status === "held";
  const detached = room.participants.filter((p) => !room.live.includes(p.id));

  return (
    <div className="chat room">
      <header className="chat-head">
        <button className="head-action" onClick={onBack} title="All rooms">
          ← Rooms
        </button>
        <div className="chat-title">
          <strong>{room.name}</strong>
          <code className="cmd">{room.topic}</code>
        </div>
        <button
          className={`head-action ${steering ? "active" : ""}`}
          onClick={() => setSteering(steering ? null : { topic: room.topic, rules: room.rules })}
          title="Change the topic or the rules; the next prompt carries them"
        >
          Steer
        </button>
        <span className="room-meter" title="Agent turns this round, and credits the agents have reported">
          turn {room.turnsThisRound}/{room.maxTurnsPerRound} · {room.creditsUsed.toFixed(2)} cr
        </span>
        <span className={`pill ${room.status === "running" ? "pill-ok" : room.status === "held" ? "pill-stale" : ""}`}>
          {room.status === "running" && speaking ? `${speaking.name} is speaking` : room.status}
        </span>
      </header>

      {steering && (
        <form
          className="room-steer"
          onSubmit={async (e) => {
            e.preventDefault();
            await verb("steer", steering);
            setSteering(null);
          }}
        >
          <label className="field">
            <span className="field-label">Topic</span>
            <textarea value={steering.topic} onChange={(e) => setSteering({ ...steering, topic: e.target.value })} rows={2} />
          </label>
          <label className="field">
            <span className="field-label">Rules</span>
            <textarea value={steering.rules} onChange={(e) => setSteering({ ...steering, rules: e.target.value })} rows={4} />
            <span className="field-hint">Every agent sees both on its next turn; nothing already said changes.</span>
          </label>
          <div className="schedule-actions">
            <button type="submit" className="primary">
              Apply
            </button>
            <button type="button" onClick={() => setSteering(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="room-people">
        {room.participants.map((p) => {
          const live = room.live.includes(p.id);
          return (
            <button
              key={p.id}
              className={`chip ${p.id === room.speaking ? "chip-on" : ""}`}
              title={`${p.role} — ${live ? "agent attached" : "agent detached; re-attaches when spoken to"}. Click for its own transcript.`}
              onClick={() => p.sessionId && onOpenSession(p.sessionId)}
            >
              <span className={`status ${p.id === room.speaking ? "status-working" : live ? "status-idle" : "status-detached"}`} />
              {p.name}
            </button>
          );
        })}
        {detached.length > 0 && !busy && (
          <span className="room-detached">
            {detached.map((p) => p.name).join(" and ")} {detached.length === 1 ? "is" : "are"} detached — they re-attach when
            spoken to, or{" "}
            <button className="room-link" onClick={() => verb("reconnect")}>
              reconnect now
            </button>
            .
          </span>
        )}
      </div>

      <div className="transcript">
        <div className="transcript-inner">
          {room.messages.length === 0 && <p className="muted">Say something to start the first round.</p>}
          {room.messages.map((m) => (
            <div key={m.id} className={`room-msg ${m.speaker === ROOM_USER ? "room-msg-user" : ""}`}>
              <span className="room-msg-name">{m.name}</span>
              {m.speaker === ROOM_USER ? <div className="msg msg-user">{m.text}</div> : <div className="msg msg-agent"><MarkdownBody>{m.text}</MarkdownBody></div>}
            </div>
          ))}
          {speaking && (
            <div className="room-msg">
              <span className="room-msg-name">{speaking.name}</span>
              {room.speakingText ? (
                <div className="msg msg-agent">
                  <MarkdownBody>{room.speakingText}</MarkdownBody>
                </div>
              ) : (
                <div className="thinking">
                  <KSpinner label={`${speaking.name} is thinking`} />
                </div>
              )}
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={busy ? "Typing holds the room; Enter sends, Cmd/Ctrl+Enter cuts in" : "Say something to start a round"}
        />
        <div className="composer-actions">
          <div className="composer-config">
            <span className="field-hint">
              {room.status === "held" && "Held — the room waits for you."}
              {room.status === "stopped" && "Stopped. Say something, or Continue."}
              {room.status === "idle" && room.messages.length > 0 && "Round over. Say something, or Continue."}
            </span>
          </div>
          <div className="composer-buttons">
            {busy && <button onClick={() => verb("stop")}>Stop</button>}
            {!busy && room.messages.length > 0 && <button onClick={() => verb("resume")}>Continue</button>}
            {busy && speaking && (
              <button onClick={() => send(true)} disabled={!draft.trim()} title="Cancel the turn in progress and send now">
                Cut in
              </button>
            )}
            <button className="primary" onClick={() => send(false)} disabled={!draft.trim() || sending}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
