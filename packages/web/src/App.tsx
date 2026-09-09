import { useCallback, useState } from "react";
import { Chat } from "./Chat.js";
import { NewChat } from "./NewChat.js";
import { Setup } from "./Setup.js";
import { Sidebar } from "./Sidebar.js";

type View =
  | { name: "welcome" }
  | { name: "setup" }
  | { name: "new" }
  | { name: "chat"; providerId?: string; cwd?: string; sessionId?: string };

/**
 * App shell: a persistent sidebar of conversations beside one main view.
 * Setup is a page you visit, not the landing screen.
 */
export function App() {
  const [view, setView] = useState<View>({ name: "welcome" });
  // Bumped whenever a chat starts, so the sidebar refetches its list.
  const [listVersion, setListVersion] = useState(0);

  const openSession = useCallback((sessionId: string) => setView({ name: "chat", sessionId }), []);
  const refreshList = useCallback(() => setListVersion((v) => v + 1), []);

  return (
    <div className="shell">
      <Sidebar
        listVersion={listVersion}
        activeSessionId={view.name === "chat" ? view.sessionId : undefined}
        onNewChat={() => setView({ name: "new" })}
        onOpenSession={openSession}
        onOpenSetup={() => setView({ name: "setup" })}
        setupActive={view.name === "setup"}
      />

      <main className="main">
        {view.name === "welcome" && (
          <div className="empty">
            <h1>KiroChrome</h1>
            <p className="muted">Start a new chat, or pick one from the left.</p>
            <button className="primary" onClick={() => setView({ name: "new" })}>
              New chat
            </button>
          </div>
        )}

        {view.name === "setup" && <Setup />}

        {view.name === "new" && (
          <NewChat
            onStart={(providerId, cwd) => setView({ name: "chat", providerId, cwd })}
            onNeedsSetup={() => setView({ name: "setup" })}
          />
        )}

        {view.name === "chat" && (
          <Chat
            key={view.sessionId ?? `${view.providerId}:${view.cwd}`}
            providerId={view.providerId}
            cwd={view.cwd}
            sessionId={view.sessionId}
            onStarted={refreshList}
          />
        )}
      </main>
    </div>
  );
}
