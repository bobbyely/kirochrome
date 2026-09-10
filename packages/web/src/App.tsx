import { useCallback, useMemo, useRef, useState } from "react";
import { Chat } from "./Chat.js";
import { NewChat, type AdoptTarget } from "./NewChat.js";
import { Setup } from "./Setup.js";
import { Sidebar } from "./Sidebar.js";
import { useShortcuts } from "./useShortcuts.js";

type View =
  | { name: "welcome" }
  | { name: "setup" }
  | { name: "new" }
  | {
      name: "chat";
      providerId?: string;
      cwd?: string;
      sessionId?: string;
      /** Set when taking over a conversation the agent already had. */
      adopt?: AdoptTarget;
    };

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

  // The sidebar owns the conversation list, so it exposes the two things
  // shortcuts need rather than the list being lifted up here.
  const sidebarApi = useRef<{ focusSearch: () => void; step: (delta: number) => void }>(null);

  const shortcuts = useMemo(
    () => ({
      onNewChat: () => setView({ name: "new" }),
      onFocusSearch: () => sidebarApi.current?.focusSearch(),
      onNextSession: (delta: number) => sidebarApi.current?.step(delta),
      onEscape: () => setView((v) => (v.name === "chat" ? v : { name: "welcome" })),
    }),
    [],
  );
  useShortcuts(shortcuts);

  return (
    <div className="shell">
      <Sidebar
        api={sidebarApi}
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
            onAdopt={(providerId, adopt) => setView({ name: "chat", providerId, adopt })}
            onOpenSession={openSession}
            onNeedsSetup={() => setView({ name: "setup" })}
          />
        )}

        {/* Deliberately unkeyed: `Chat` owns the WebSocket, so remounting it per
            conversation would close and redial the socket on every switch.
            Switching is a `subscribe` on the connection we already have. */}
        {view.name === "chat" && (
          <Chat
            providerId={view.providerId}
            cwd={view.cwd}
            sessionId={view.sessionId}
            adopt={view.adopt}
            onStarted={refreshList}
            onOpenSetup={() => setView({ name: "setup" })}
          />
        )}
      </main>
    </div>
  );
}
