import { useState } from "react";
import { Chat } from "./Chat.js";
import { Setup } from "./Setup.js";

/** Two views for now: verify providers, then chat with one. */
export function App() {
  const [chatProvider, setChatProvider] = useState<string | null>(null);

  return chatProvider ? (
    <Chat providerId={chatProvider} onBack={() => setChatProvider(null)} />
  ) : (
    <Setup onUseProvider={setChatProvider} />
  );
}
