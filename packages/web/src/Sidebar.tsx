import { useEffect } from "react";
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
  const { connected, sessions, listSessions } = useChat();

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
        {sessions?.map((session) => (
          <button
            key={session.id}
            className={`sidebar-item ${session.id === activeSessionId ? "active" : ""}`}
            onClick={() => onOpenSession(session.id)}
          >
            <span className="sidebar-item-title">{session.title ?? "Untitled"}</span>
            <span className="sidebar-item-sub">{session.providerName}</span>
          </button>
        ))}
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
