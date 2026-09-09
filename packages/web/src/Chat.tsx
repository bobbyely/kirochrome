import { useEffect, useMemo, useRef, useState } from "react";
import { latestUsage } from "@kirochrome/shared";
import type { ConfigOption, SessionUsage } from "@kirochrome/shared";
import { MarkdownBody } from "./Markdown.js";
import { buildRows, toolSubtitle, type Row } from "./timeline.js";
import { useChat } from "./useChat.js";

export function Chat({
  providerId,
  cwd,
  sessionId,
  onStarted,
}: {
  providerId?: string;
  cwd?: string;
  sessionId?: string;
  onStarted?: () => void;
}) {
  const {
    connected,
    session,
    events,
    error,
    openSession,
    attachSession,
    resumeSession,
    setConfigOption,
    answerPermission,
    setAutoApprove,
    prompt,
    cancel,
  } = useChat();

  const [draft, setDraft] = useState("");
  const opened = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connected || opened.current) return;
    opened.current = true;
    if (sessionId) attachSession(sessionId);
    else if (providerId) openSession(providerId, cwd);
  }, [connected, openSession, attachSession, providerId, cwd, sessionId]);

  const rows = useMemo(() => buildRows(events), [events]);
  const usage = useMemo(() => latestUsage(events), [events]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows.length]);

  useEffect(() => {
    if (session?.live) onStarted?.();
  }, [session?.live, onStarted]);

  const busy = session?.busy ?? false;
  // A session read back from disk has no agent attached until it is resumed.
  const readOnly = session !== null && !session.live;

  const submit = () => {
    const text = draft.trim();
    if (!text || busy || readOnly) return;
    prompt(text);
    setDraft("");
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <strong>{session?.title ?? session?.providerName ?? "Conversation"}</strong>
          {session && <code className="cmd">{session.cwd}</code>}
        </div>
        {usage && <ContextMeter usage={usage} />}
        <span className={`pill ${connected ? "pill-ok" : "pill-stale"}`}>
          {connected ? "Connected" : "Reconnecting…"}
        </span>
      </header>

      <div className="transcript">
        {/* Inner wrapper caps line length; alignment happens inside it, so
            user messages can still sit right while the column stays centred. */}
        <div className="transcript-inner">
          {!session && <p className="muted">{sessionId ? "Loading conversation…" : "Starting agent…"}</p>}
          {rows.map((row) => (
            <Message key={row.seq} row={row} onPermission={answerPermission} />
          ))}
          {busy && <div className="thinking">Working…</div>}
          <div ref={bottom} />
        </div>
      </div>

      {error && (
        <div className="banner">
          <strong>{error.code}</strong> {error.message}
          {error.remediation && <p className="remediation">{error.remediation}</p>}
        </div>
      )}

      {readOnly ? (
        <div className="composer readonly">
          <p className="muted">
            This conversation was restored from disk. Re-attach an agent to continue it.
          </p>
          <button className="primary" onClick={() => sessionId && resumeSession(sessionId)}>
            Resume conversation
          </button>
        </div>
      ) : (
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
            <div className="composer-config">
              {session?.live && (
                <label className="config-toggle" title="Approve tool calls without asking">
                  <input
                    type="checkbox"
                    checked={session.autoApprove}
                    onChange={(e) => setAutoApprove(e.target.checked)}
                  />
                  Auto-approve
                </label>
              )}
              {session?.configOptions.map((option) => (
                <ConfigPicker
                  key={option.id}
                  option={option}
                  onChange={(value) => setConfigOption(option.id, value)}
                />
              ))}
            </div>
            {busy ? (
              <button onClick={cancel}>Stop</button>
            ) : (
              <button className="primary" onClick={submit} disabled={!draft.trim() || !session}>
                Send
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Message({
  row,
  onPermission,
}: {
  row: Row;
  onPermission: (requestId: string, optionId: string | null) => void;
}) {
  switch (row.kind) {
    case "user":
      return <div className="msg msg-user">{row.text}</div>;
    case "agent":
      return (
        <div className="msg msg-agent">
          <MarkdownBody>{row.text}</MarkdownBody>
        </div>
      );
    case "thought":
      return <div className="msg msg-thought">{row.text}</div>;
    case "tool":
      return <ToolCard row={row} />;
    case "permission":
      return <PermissionCard row={row} onAnswer={onPermission} />;
    case "note":
      return <div className="msg msg-note">{row.label}</div>;
    case "divider":
      return <hr className="turn-divider" />;
    case "error":
      return (
        <div className="msg msg-error">
          <span className="code">{row.code}</span> {row.message}
          {row.remediation && <p className="remediation">{row.remediation}</p>}
        </div>
      );
  }
}

const STATUS_MARK: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  failed: "✗",
};

/**
 * One agent action, with all of its updates folded in, collapsed until asked.
 * An always-expanded transcript of tool output is unreadable.
 */
function ToolCard({ row }: { row: Extract<Row, { kind: "tool" }> }) {
  const subtitle = toolSubtitle(row.details);
  return (
    <details className={`tool tool-${row.status}`}>
      <summary>
        <span className="tool-mark">{STATUS_MARK[row.status] ?? "○"}</span>
        <span className="tool-title">{row.title}</span>
        {subtitle && subtitle !== row.title && <code className="tool-sub">{subtitle}</code>}
      </summary>
      <pre>{row.details.map((d) => JSON.stringify(d, null, 2)).join("\n")}</pre>
    </details>
  );
}

/** The agent is blocked on this request until the user answers it. */
function PermissionCard({
  row,
  onAnswer,
}: {
  row: Extract<Row, { kind: "permission" }>;
  onAnswer: (requestId: string, optionId: string | null) => void;
}) {
  const answered = row.answeredWith !== null;
  return (
    <div className={`permission ${answered ? "answered" : ""}`}>
      <div className="permission-title">{row.title}</div>
      {answered ? (
        <span className="muted">
          {row.answeredWith === "cancelled" ? "Cancelled" : `Answered: ${row.answeredWith}`}
        </span>
      ) : (
        <div className="permission-actions">
          {row.options.map((option) => (
            <button
              key={option.optionId}
              className={option.kind.startsWith("allow") ? "primary" : ""}
              onClick={() => onAnswer(row.requestId, option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One agent-advertised setting, rendered from whatever the agent offers.
 * Never a hardcoded model list — see invariant 5 in AGENTS.md.
 */
function ConfigPicker({
  option,
  onChange,
}: {
  option: ConfigOption;
  onChange: (value: string | boolean) => void;
}) {
  if (option.type === "boolean") {
    return (
      <label className="config-toggle" title={option.description ?? option.name}>
        <input
          type="checkbox"
          checked={Boolean(option.currentValue)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {option.name}
      </label>
    );
  }
  return (
    <select
      className="config-select"
      title={option.description ?? option.name}
      value={String(option.currentValue)}
      onChange={(e) => onChange(e.target.value)}
    >
      {option.options?.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.name}
        </option>
      ))}
    </select>
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
