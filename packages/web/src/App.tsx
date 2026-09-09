import { useState } from "react";
import { Chat } from "./Chat.js";
import { Setup } from "./Setup.js";

/** Two views for now: verify providers, then chat with one. */
export function App() {
  const [view, setView] = useState<
    { name: "setup" } | { name: "new"; providerId: string } | { name: "open"; sessionId: string }
  >({ name: "setup" });

  const back = () => setView({ name: "setup" });

  if (view.name === "new") return <Chat providerId={view.providerId} onBack={back} />;
  if (view.name === "open") return <Chat sessionId={view.sessionId} onBack={back} />;
  return (
    <Setup
      onUseProvider={(providerId) => setView({ name: "new", providerId })}
      onOpenSession={(sessionId) => setView({ name: "open", sessionId })}
    />
  );
}
