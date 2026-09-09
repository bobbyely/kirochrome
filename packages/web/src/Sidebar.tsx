import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@kirochrome/shared";
import { useChat } from "./useChat.js";

/** Persistent left rail: new chat, past conversations, and a way into Setup. */
export function Sidebar({
  listVersion,
  activeSessionId,
  onNewChat,
  onOpenSession,
  onOpenSetup,
  setupActive,
}: {
  listVersion: number;
  activeSessionId?: string | undefined;
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
  onOpenSetup: () => void;
  setupActive: boolean;
}) {
  const { connected, sessions, listSessions, renameSession, archiveSession, search, searchHits } =
    useChat();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (connected) listSessions(showArchived);
  }, [connected, listSessions, listVersion, showArchived]);

  // Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => search(query), 180);
    return () => window.clearTimeout(id);
  }, [query, search]);

  const searching = query.trim().length > 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">KiroChrome</span>
      </div>

      <button className="new-chat" onClick={onNewChat}>
        <span className="plus">+</span> New chat
      </button>

      <div className="sidebar-search">
        <input
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
        {sessions?.length === 0 && (
          <p className="sidebar-empty">{showArchived ? "Nothing here." : "No conversations yet."}</p>
        )}
        {sessions?.map((session) =>
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
          ),
        )}
      </nav>
      )}

      <div className="sidebar-foot">
        <button className={`setup-link ${setupActive ? "active" : ""}`} onClick={onOpenSetup}>
          Setup
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
    </aside>
  );
}

/**
 * At-a-glance state for a conversation: waiting on you, working, idle, or
 * detached. Ordered by urgency — a blocked agent matters more than a busy one.
 */
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
