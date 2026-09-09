import { useEffect, useMemo, useRef, useState } from "react";
import { latestUsage, updateCategory } from "@kirochrome/shared";
import type { KcEvent, SessionUsage } from "@kirochrome/shared";
import { useChat } from "./useChat.js";

/**
 * Renders the event log. Deliberately a pure projection of `events` — no
 * message state of its own, so a reconnect or replay produces identical output.
 */
type Bubble =
  | { kind: "user"; seq: number; text: string }
  | { kind: "agent"; seq: number; text: string }
  | { kind: "tool"; seq: number; label: string }
  | { kind: "thought"; seq: number; text: string }
  | { kind: "divider"; seq: number }
  | { kind: "error"; seq: number; code: string; message: string; remediation?: string }
  | { kind: "exit"; seq: number; label: string };

function toBubbles(events: KcEvent[]): Bubble[] {
  const bubbles: Bubble[] = [];
  for (const event of events) {
    switch (event.type) {
      case "user_message":
        bubbles.push({ kind: "user", seq: event.seq, text: event.text });
        break;
      case "agent_text": {
        // Merge consecutive agent text into one bubble so flush boundaries
        // are invisible to the reader.
        const last = bubbles.at(-1);
        if (last?.kind === "agent") last.text += event.text;
        else bubbles.push({ kind: "agent", seq: event.seq, text: event.text });
        break;
      }
      case "agent_update": {
        const u = event.update as {
          sessionUpdate?: string;
          title?: string;
          status?: string;
          content?: { text?: string };
        };
        // State updates describe the session, not the conversation. They stay
        // in the log and feed the header; they are not transcript rows.
        if (updateCategory(u.sessionUpdate) === "state") break;

        if (u.sessionUpdate === "agent_thought_chunk") {
          const last = bubbles.at(-1);
          const text = u.content?.text ?? "";
          if (last?.kind === "thought") last.text += text;
          else bubbles.push({ kind: "thought", seq: event.seq, text });
          break;
        }
        bubbles.push({
          kind: "tool",
          seq: event.seq,
          label: [u.sessionUpdate, u.title, u.status].filter(Boolean).join(" · "),
        });
        break;
      }
      case "error":
        bubbles.push({
          kind: "error",
          seq: event.seq,
          code: event.error.code,
          message: event.error.message,
          remediation: event.error.remediation,
        });
        break;
      case "agent_exited":
        bubbles.push({
          kind: "exit",
          seq: event.seq,
          label: `Agent exited (${event.signal ?? `code ${event.code}`})`,
        });
        break;
      case "turn_end":
        // A quiet rule between turns, so a long transcript stays readable.
        if (bubbles.length > 0) bubbles.push({ kind: "divider", seq: event.seq });
        break;
      // turn_start drives the busy indicator, not the transcript.
    }
  }
  return bubbles;
}

export function Chat({ providerId, onBack }: { providerId: string; onBack: () => void }) {
  const { connected, session, events, error, openSession, prompt, cancel } = useChat();
  const [draft, setDraft] = useState("");
  const opened = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (connected && !opened.current) {
      opened.current = true;
      openSession(providerId);
    }
  }, [connected, openSession, providerId]);

  const bubbles = useMemo(() => toBubbles(events), [events]);
  const usage = useMemo(() => latestUsage(events), [events]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles.length]);

  const busy = session?.busy ?? false;

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    prompt(text);
    setDraft("");
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <button onClick={onBack}>← Setup</button>
        <div className="chat-title">
          <strong>{session?.providerName ?? providerId}</strong>
          {session && <code className="cmd">{session.cwd}</code>}
        </div>
        {usage && <ContextMeter usage={usage} />}
        <span className={`pill ${connected ? "pill-ok" : "pill-stale"}`}>
          {connected ? "Connected" : "Reconnecting…"}
        </span>
      </header>

      <div className="transcript">
        {!session && <p className="muted">Starting agent…</p>}
        {bubbles.map((b) => (
          <Message key={b.seq} bubble={b} />
        ))}
        {busy && <div className="thinking">Working…</div>}
        <div ref={bottom} />
      </div>

      {error && (
        <div className="banner">
          <strong>{error.code}</strong> {error.message}
          {error.remediation && <p className="remediation">{error.remediation}</p>}
        </div>
      )}

      <div className="composer">
        <textarea
          value={draft}
          placeholder={busy ? "Working…" : "Send a message"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
        />
        <div className="composer-actions">
          <span className="muted hint">Enter to send · Shift+Enter for a newline</span>
          {busy ? (
            <button onClick={cancel}>Stop</button>
          ) : (
            <button className="primary" onClick={submit} disabled={!draft.trim() || !session}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Context-window pressure, read straight out of the log's usage updates. */
function ContextMeter({ usage }: { usage: SessionUsage }) {
  const { used, size, cost } = usage;
  const pct = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0;
  const money =
    cost &&
    new Intl.NumberFormat(undefined, { style: "currency", currency: cost.currency }).format(cost.amount);
  const title = `${used.toLocaleString()} / ${size.toLocaleString()} tokens${money ? ` · ${money}` : ""}`;
  return (
    <div className="context-meter" title={title}>
      <div className="context-bar">
        <div className={`context-fill ${pct >= 85 ? "high" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="context-pct">{pct}%</span>
    </div>
  );
}

function Message({ bubble }: { bubble: Bubble }) {
  switch (bubble.kind) {
    case "user":
      return <div className="msg msg-user">{bubble.text}</div>;
    case "agent":
      return <div className="msg msg-agent">{bubble.text}</div>;
    case "tool":
      return <div className="msg msg-tool">{bubble.label}</div>;
    case "thought":
      return <div className="msg msg-thought">{bubble.text}</div>;
    case "divider":
      return <hr className="turn-divider" />;
    case "exit":
      return <div className="msg msg-exit">{bubble.label}</div>;
    case "error":
      return (
        <div className="msg msg-error">
          <span className="code">{bubble.code}</span> {bubble.message}
          {bubble.remediation && <p className="remediation">{bubble.remediation}</p>}
        </div>
      );
  }
}
