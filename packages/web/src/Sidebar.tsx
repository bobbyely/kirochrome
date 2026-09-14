import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { RoomView, ScheduleRun, ScheduleView, SessionSummary } from "@kirochrome/shared";
import { fetchRooms, fetchSchedules } from "./api.js";
import { GamesPanel } from "./games/Games.js";
import { useChat } from "./useChat.js";

const WIDTH_KEY = "kc.sidebar.width";
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 264;
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_WIDTH), MAX_WIDTH));

function loadWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return clampWidth(stored > 0 ? stored : DEFAULT_WIDTH);
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** Persistent left rail: new chat, past conversations, a way into Setup, and the games. */
export interface SidebarApi {
  focusSearch: () => void;
  step: (delta: number) => void;
}

export function Sidebar({
  api,
  listVersion,
  activeSessionId,
  onNewChat,
  onOpenSession,
  onOpenSetup,
  setupActive,
  onOpenSchedules,
  schedulesActive,
  onOpenSchedule,
  activeScheduleId,
  onOpenRooms,
  roomsActive,
  onOpenRoom,
  activeRoomId,
}: {
  api: RefObject<SidebarApi | null>;
  listVersion: number;
  activeSessionId?: string | undefined;
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
  onOpenSetup: () => void;
  setupActive: boolean;
  onOpenSchedules: () => void;
  schedulesActive: boolean;
  onOpenSchedule: (id: string) => void;
  activeScheduleId?: string | undefined;
  onOpenRooms: () => void;
  roomsActive: boolean;
  onOpenRoom: (id: string) => void;
  activeRoomId?: string | undefined;
}) {
  const { connected, sessions, listSessions, renameSession, archiveSession, search, searchHits } =
    useChat();
  const [renaming, setRenaming] = useState<string | null>(null);
  // The games live here rather than in Chat because this rail is on every
  // screen, and it already knows which conversation is waiting on the user.
  // They are positioned fixed, so where they render makes no visual difference.
  const [playing, setPlaying] = useState(false);

  // Drag the right edge to resize. The width is a per-browser convenience,
  // like the theme, and the shell reads it from a CSS variable.
  const [width, setWidth] = useState(loadWidth);
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  }, [width]);
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => setWidth(clampWidth(ev.clientX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          // Then it is simply not remembered.
        }
        return w;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);

  useImperativeHandle(api, () => ({
    focusSearch: () => searchInput.current?.select(),
    step: (delta: number) => {
      if (!sessions || sessions.length === 0) return;
      const current = sessions.findIndex((s) => s.id === activeSessionId);
      // From nowhere, Down starts at the top and Up at the bottom.
      const next = current === -1 ? (delta > 0 ? 0 : sessions.length - 1) : current + delta;
      const wrapped = (next + sessions.length) % sessions.length;
      onOpenSession(sessions[wrapped]!.id);
    },
  }));

  useEffect(() => {
    if (connected) listSessions(showArchived);
  }, [connected, listSessions, listVersion, showArchived]);

  // Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => search(query), 180);
    return () => window.clearTimeout(id);
  }, [query, search]);

  const searching = query.trim().length > 0;

  // A schedule's runs are one conversation each, and forty-eight a day of the
  // same prompt would bury the ones you typed. The sidebar lists the schedule
  // instead, once; its runs are on its own page.
  const own = (sessions ?? []).filter((s) => !s.scheduleId && !s.roomId);
  const [schedules, setSchedules] = useState<ScheduleView[]>([]);
  const [rooms, setRooms] = useState<RoomView[]>([]);
  // Refetched when the session list changes, which a run ending or a room
  // turn always does.
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSchedules(), fetchRooms()])
      .then(([s, r]) => {
        if (cancelled) return;
        setSchedules(s.schedules);
        setRooms(r.rooms);
      })
      .catch(() => {
        // The lists are decoration here; their pages report the error.
      });
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  const renderItem = (session: SessionSummary) =>
    renaming === session.id ? (
      <RenameField
        key={session.id}
        session={session}
        onCommit={(title) => {
          if (title.trim()) renameSession(session.id, title);
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />
    ) : (
      <div
        key={session.id}
        className={`sidebar-item ${session.id === activeSessionId ? "active" : ""} ${
          session.archived ? "archived" : ""
        }`}
      >
        <button
          className="sidebar-item-main"
          onClick={() => onOpenSession(session.id)}
          onDoubleClick={() => setRenaming(session.id)}
          title={session.title ?? "Untitled"}
        >
          <span className="sidebar-item-title">
            <StatusIcon session={session} />
            {session.title ?? "Untitled"}
          </span>
          <span className="sidebar-item-sub">{session.providerName}</span>
        </button>
        <button
          className="sidebar-action"
          title="Rename"
          aria-label={`Rename ${session.title ?? "conversation"}`}
          onClick={() => setRenaming(session.id)}
        >
          ✎
        </button>
        <button
          className="sidebar-action"
          title={session.archived ? "Restore" : "Archive"}
          aria-label={`${session.archived ? "Restore" : "Archive"} ${session.title ?? "conversation"}`}
          onClick={() => archiveSession(session.id, !session.archived)}
        >
          {session.archived ? "⤺" : "⌸"}
        </button>
      </div>
    );

  return (
    <aside className="sidebar">
      <div className="sidebar-resize" onPointerDown={startResize} title="Drag to resize" />
      <div className="sidebar-head">
        <span className="brand">KiroChrome</span>
      </div>

      <button className="new-chat" onClick={onNewChat}>
        <span className="plus">+</span> New chat
      </button>

      <div className="sidebar-search">
        <input
          ref={searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
        />
        {searching && (
          <button className="search-clear" onClick={() => setQuery("")} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {searching ? (
        <nav className="sidebar-list">
          {searchHits?.length === 0 && <p className="sidebar-empty">No matches.</p>}
          {searchHits?.map((hit) => (
            <button key={hit.sessionId} className="search-hit" onClick={() => onOpenSession(hit.sessionId)}>
              <span className="sidebar-item-title">{hit.title ?? "Untitled"}</span>
              <Snippet text={hit.snippet} />
            </button>
          ))}
        </nav>
      ) : (
      <nav className="sidebar-list">
        {/* Each kind of thing folds, so a long list of one does not push the
            others off the bottom; the list as a whole scrolls. */}
        <details className="sidebar-group" open>
          <summary>Conversations ({own.length})</summary>
          {own.length === 0 && (
            <p className="sidebar-empty">{showArchived ? "Nothing here." : "No conversations yet."}</p>
          )}
          {own.map(renderItem)}
        </details>
        {rooms.length > 0 && (
          <details className="sidebar-group" open>
            <summary>Rooms ({rooms.length})</summary>
            {rooms.map((room) => (
              <div key={room.id} className={`sidebar-item ${room.id === activeRoomId ? "active" : ""}`}>
                <button className="sidebar-item-main" onClick={() => onOpenRoom(room.id)} title={room.topic}>
                  <span className="sidebar-item-title">
                    <span
                      className={`status ${room.status === "running" ? "status-working" : room.status === "held" ? "status-input" : "status-idle"}`}
                      aria-label={room.status}
                    />
                    {room.name}
                  </span>
                  <span className="sidebar-item-sub">{room.participants.map((p) => p.name).join(", ")}</span>
                </button>
              </div>
            ))}
          </details>
        )}
        {schedules.length > 0 && (
          <details className="sidebar-group" open>
            <summary>
              Schedules ({schedules.length})
              {schedules.some((s) => s.runs[0]?.unread) && (
                <span className="status status-unread" aria-label="Unread runs" />
              )}
            </summary>
            {schedules.map((schedule) => (
              <div
                key={schedule.id}
                className={`sidebar-item ${schedule.id === activeScheduleId ? "active" : ""}`}
              >
                <button className="sidebar-item-main" onClick={() => onOpenSchedule(schedule.id)} title={schedule.name}>
                  <span className="sidebar-item-title">
                    <RunIcon run={schedule.runs[0]} />
                    {schedule.name}
                  </span>
                  <span className="sidebar-item-sub">
                    {schedule.runs.length} run{schedule.runs.length === 1 ? "" : "s"}
                    {schedule.status === "paused" && " · paused"}
                  </span>
                </button>
              </div>
            ))}
          </details>
        )}
      </nav>
      )}

      <div className="sidebar-foot">
        <button className={`setup-link ${setupActive ? "active" : ""}`} onClick={onOpenSetup}>
          Setup
        </button>
        <button className={`setup-link ${schedulesActive ? "active" : ""}`} onClick={onOpenSchedules}>
          Schedules
        </button>
        <button className={`setup-link ${roomsActive ? "active" : ""}`} onClick={onOpenRooms}>
          Rooms
        </button>
        <button
          className={`setup-link ${showArchived ? "active" : ""}`}
          onClick={() => setShowArchived((v) => !v)}
          title="Archived conversations are hidden from this list"
        >
          {showArchived ? "Hide archived" : "Archived"}
        </button>
        <span className={`dot ${connected ? "dot-ok" : "dot-off"}`} title={connected ? "Connected" : "Disconnected"} />
      </div>
      {!playing && (
        <button className="games-open" onClick={() => setPlaying(true)} title="Something to do while an agent works">
          Play
        </button>
      )}
      <GamesPanel
        open={playing}
        awaitingInput={sessions?.some((s) => s.awaitingInput) ?? false}
        onClose={() => setPlaying(false)}
      />
    </aside>
  );
}

/**
 * At-a-glance state for a conversation: waiting on you, working, idle, or
 * detached. Ordered by urgency — a blocked agent matters more than a busy one.
 */
/** A schedule's state is its latest run's. */
function RunIcon({ run }: { run: ScheduleRun | undefined }) {
  if (!run) return <span className="status status-detached" title="Never run" aria-label="Never run" />;
  if (run.outcome === "running") return <span className="status status-working" title="Running" aria-label="Running" />;
  if (run.unread) return <span className="status status-unread" title="A run you have not opened" aria-label="Unread" />;
  if (run.outcome === "failed") return <span className="status status-failed" title="Last run failed" aria-label="Failed" />;
  return <span className="status status-idle" title="Last run ok" aria-label="Ok" />;
}

function StatusIcon({ session }: { session: SessionSummary }) {
  if (session.awaitingInput) {
    return <span className="status status-input" title="Waiting for your answer" aria-label="Needs input" />;
  }
  if (session.busy) {
    return <span className="status status-working" title="Working" aria-label="Working" />;
  }
  if (!session.live) {
    return <span className="status status-detached" title="No agent attached" aria-label="Detached" />;
  }
  return <span className="status status-idle" title="Ready" aria-label="Ready" />;
}

/**
 * Renders a search snippet, highlighting the matched terms.
 *
 * SQLite marks matches with \u0002 and \u0003 rather than HTML, so the text is
 * split on those and rendered as elements — no dangerouslySetInnerHTML, and no
 * way for conversation text to inject markup.
 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\u0002|\u0003/);
  return (
    <span className="search-snippet">
      {parts.map((part, i) =>
        i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
      )}
    </span>
  );
}

function RenameField({
  session,
  onCommit,
  onCancel,
}: {
  session: SessionSummary;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(session.title ?? "");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.select();
  }, []);

  return (
    <input
      ref={input}
      className="sidebar-rename-input"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}
