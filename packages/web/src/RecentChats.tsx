import { useEffect } from "react";
import { useChat } from "./useChat.js";

/**
 * Past conversations, read straight out of the persisted log.
 *
 * Reuses the chat socket rather than adding an HTTP route: session listing is
 * the same data the chat view already subscribes to.
 */
export function RecentChats({ onOpen }: { onOpen: (id: string) => void }) {
  const { connected, sessions, listSessions } = useChat();

  useEffect(() => {
    if (connected) listSessions();
  }, [connected, listSessions]);

  if (!sessions || sessions.length === 0) return null;

  return (
    <section className="recent">
      <h2>Recent chats</h2>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <button className="recent-row" onClick={() => onOpen(session.id)}>
              <span className="recent-title">{session.title ?? "Untitled conversation"}</span>
              <span className="recent-meta">
                {session.providerName}
                {session.live && <span className="pill pill-ok">Live</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
