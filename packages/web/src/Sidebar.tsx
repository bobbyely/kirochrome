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
  const { connected, sessions, listSessions, renameSession } = useChat();
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    if (connected) listSessions();
  }, [connected, listSessions, listVersion]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">KiroChrome</span>
      </div>

      <button className="new-chat" onClick={onNewChat}>
        <span className="plus">+</span> New chat
      </button>

      <nav className="sidebar-list">
        {sessions?.length === 0 && <p className="sidebar-empty">No conversations yet.</p>}
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
            <div key={session.id} className={`sidebar-item ${session.id === activeSessionId ? "active" : ""}`}>
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
                className="sidebar-rename"
                title="Rename"
                aria-label={`Rename ${session.title ?? "conversation"}`}
                onClick={() => setRenaming(session.id)}
              >
                ✎
              </button>
            </div>
          ),
        )}
      </nav>

      <div className="sidebar-foot">
        <button className={`setup-link ${setupActive ? "active" : ""}`} onClick={onOpenSetup}>
          Setup
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
