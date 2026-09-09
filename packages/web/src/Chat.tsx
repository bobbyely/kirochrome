import { useEffect, useMemo, useRef, useState } from "react";
import { isProviderFault, latestUsage } from "@kirochrome/shared";
import type { ConfigOption, SessionUsage } from "@kirochrome/shared";
import { MarkdownBody } from "./Markdown.js";
import { collapseContext, countChanges, lineDiff } from "./diff.js";
import { fileToImage, type PendingImage } from "./images.js";
import { buildRows, languageFor, toolContent, toolSubtitle, type Row, type ToolDiff } from "./timeline.js";
import { useChat } from "./useChat.js";

export function Chat({
  providerId,
  cwd,
  sessionId,
  onStarted,
  onOpenSetup,
}: {
  providerId?: string;
  cwd?: string;
  sessionId?: string;
  onStarted?: () => void;
  onOpenSetup?: () => void;
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
    unqueue,
    prompt,
    cancel,
  } = useChat();

  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
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

  const queued = session?.queued ?? [];

  const submit = () => {
    const text = draft.trim();
    // Deliberately allowed while busy: the server queues it and sends it when
    // the current turn ends.
    if ((!text && images.length === 0) || readOnly) return;
    prompt(text, images.map(({ mime, data }) => ({ mime, data })));
    setDraft("");
    setImages([]);
  };

  const canAttach = session?.supportsImages === true;

  /** Collects images from a paste or drop, ignoring anything else. */
  const collect = async (files: FileList | File[] | null) => {
    if (!canAttach || !files) return;
    const picked: PendingImage[] = [];
    for (const file of Array.from(files)) {
      const image = await fileToImage(file);
      if (image) picked.push(image);
    }
    if (picked.length > 0) setImages((prev) => [...prev, ...picked]);
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <strong>{session?.title ?? session?.providerName ?? "Conversation"}</strong>
          {session && <code className="cmd">{session.cwd}</code>}
        </div>
        {session && (
          // A plain link: the server sets content-disposition, so the browser
          // handles the download without any client-side blob juggling.
          <a
            className="head-action"
            href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
            download
            title="Export this conversation as Markdown"
          >
            Export
          </a>
        )}
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
          <div className="banner-body">
            <strong>{error.code}</strong> {error.message}
            {error.remediation && <p className="remediation">{error.remediation}</p>}
          </div>
          {/* A provider fault is not this conversation's problem to solve. */}
          {isProviderFault(error.code) && onOpenSetup && (
            <button onClick={onOpenSetup}>Go to Setup</button>
          )}
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
          {queued.length > 0 && (
            <div className="queued">
              <span className="queued-label">Queued ({queued.length})</span>
              {queued.map((text, i) => (
                <div key={`${i}-${text}`} className="queued-item">
                  <span className="queued-text">{text}</span>
                  <button
                    className="queued-remove"
                    aria-label="Remove queued message"
                    title="Remove"
                    onClick={() => unqueue(i)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="attachments">
              {images.map((image) => (
                <div key={image.key} className="attachment">
                  <img src={`data:${image.mime};base64,${image.data}`} alt={image.name} />
                  <button
                    aria-label={`Remove ${image.name}`}
                    onClick={() => setImages((prev) => prev.filter((i) => i.key !== image.key))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={draft}
            placeholder={
              busy
                ? "Type to queue for when this turn ends…"
                : canAttach
                  ? "Send a message — paste or drop an image to attach it"
                  : "Send a message"
            }
            onPaste={(e) => void collect(e.clipboardData?.files ?? null)}
            onDragOver={(e) => canAttach && e.preventDefault()}
            onDrop={(e) => {
              if (!canAttach) return;
              e.preventDefault();
              void collect(e.dataTransfer?.files ?? null);
            }}
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
            <div className="composer-buttons">
              {busy && <button onClick={cancel}>Stop</button>}
              <button
                className="primary"
                onClick={submit}
                disabled={(!draft.trim() && images.length === 0) || !session}
              >
                {busy ? "Queue" : "Send"}
              </button>
            </div>
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
      return (
        <div className="msg msg-user">
          {row.attachments.length > 0 && (
            <div className="msg-images">
              {row.attachments.map((a) => (
                <img key={a.id} src={`/api/attachments/${encodeURIComponent(a.id)}`} alt="attachment" />
              ))}
            </div>
          )}
          {row.text}
        </div>
      );
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
    case "work":
      return <WorkGroup row={row} onPermission={onPermission} />;
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

/**
 * A run of tool calls and thinking, collapsed into one row.
 *
 * Open while the agent is still working so progress is visible, then collapsed
 * once it finishes — unless the reader has taken control of the toggle, in
 * which case their choice wins.
 */
function WorkGroup({
  row,
  onPermission,
}: {
  row: Extract<Row, { kind: "work" }>;
  onPermission: (requestId: string, optionId: string | null) => void;
}) {
  const [open, setOpen] = useState(row.active);
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current) setOpen(row.active);
  }, [row.active]);

  const parts = [
    row.tools > 0 ? `Ran ${row.tools} tool${row.tools === 1 ? "" : "s"}` : null,
    row.thoughts > 0 ? "thought" : null,
  ].filter(Boolean);

  return (
    <details
      className="work"
      open={open}
      onToggle={(e) => {
        touched.current = true;
        setOpen((e.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary>
        <span className={`work-mark ${row.active ? "active" : ""}`}>{row.active ? "◐" : "●"}</span>
        <span>{parts.join(" · ") || "Work"}</span>
      </summary>
      <div className="work-children">
        {row.children.map((child) => (
          <Message key={child.seq} row={child} onPermission={onPermission} />
        ))}
      </div>
    </details>
  );
}

const STATUS_MARK: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  failed: "✗",
};

const KIND_MARK: Record<string, string> = {
  read: "◇", edit: "✎", delete: "␡", move: "⇄", search: "⌕",
  execute: "▸", think: "◌", fetch: "↓", switch_mode: "⇋", other: "•",
};

/**
 * One agent action, with all of its updates folded in, collapsed until asked.
 * An always-expanded transcript of tool output is unreadable.
 */
function ToolCard({ row }: { row: Extract<Row, { kind: "tool" }> }) {
  const subtitle = toolSubtitle(row.details);
  const content = toolContent(row.details);
  const hasBody = content.diffs.length > 0 || content.texts.length > 0;
  const summary = content.diffs.length > 0 ? diffSummary(content.diffs) : null;

  return (
    <details className={`tool tool-${row.status}`}>
      <summary>
        <span className="tool-mark">{STATUS_MARK[row.status] ?? "○"}</span>
        <span className="tool-kind">{KIND_MARK[row.toolKind] ?? "•"}</span>
        <span className="tool-title">{row.title}</span>
        {subtitle && subtitle !== row.title && <code className="tool-sub">{subtitle}</code>}
        {summary && <span className="tool-stat">{summary}</span>}
      </summary>

      <div className="tool-body">
        {content.diffs.map((diff, i) => (
          <DiffView key={`${diff.path}-${i}`} diff={diff} />
        ))}

        {content.texts.map((text, i) => (
          <CodeBlock key={i} text={text} language={languageFor(subtitle ?? "")} />
        ))}

        {content.terminalIds.map((id) => (
          <p key={id} className="muted tool-note">
            Output streamed to terminal {id.slice(0, 8)}
          </p>
        ))}

        {/* The raw payload stays reachable, just not in your face. */}
        <details className="tool-raw">
          <summary>{hasBody ? "Raw payload" : "No rendered content — raw payload"}</summary>
          <pre>{row.details.map((d) => JSON.stringify(d, null, 2)).join("\n")}</pre>
        </details>
      </div>
    </details>
  );
}

function diffSummary(diffs: ToolDiff[]): string {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    const lines = lineDiff(diff.oldText, diff.newText);
    if (!lines) continue;
    const counts = countChanges(lines);
    added += counts.added;
    removed += counts.removed;
  }
  return `+${added} −${removed}`;
}

/** A file edit, rendered as a diff rather than two blobs of JSON. */
function DiffView({ diff }: { diff: ToolDiff }) {
  const lines = lineDiff(diff.oldText, diff.newText);
  if (!lines) {
    // Too large for the quadratic LCS; show the result rather than nothing.
    return (
      <div className="diff">
        <div className="diff-head">{diff.path} <span className="muted">(too large to diff)</span></div>
        <CodeBlock text={diff.newText} language={languageFor(diff.path)} />
      </div>
    );
  }

  const rows = collapseContext(lines);
  const { added, removed } = countChanges(lines);
  return (
    <div className="diff">
      <div className="diff-head">
        <code>{diff.path}</code>
        <span className="diff-stat">+{added} −{removed}</span>
      </div>
      <pre className="diff-body">
        {rows.map((row, i) =>
          row.kind === "gap" ? (
            <span key={i} className="diff-gap">{`⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"}\n`}</span>
          ) : (
            <span key={i} className={`diff-line diff-${row.kind}`}>
              {`${row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "} ${row.text}\n`}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}

/** Tool text output, highlighted when we can guess the language. */
function CodeBlock({ text, language }: { text: string; language: string }) {
  return <MarkdownBody>{`\`\`\`${language}\n${text}\n\`\`\``}</MarkdownBody>;
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
  // Include the id in the tooltip: when an agent advertises something
  // unexpected, the label alone does not say where it came from.
  const hint = `${option.name}${option.description ? ` — ${option.description}` : ""} (${option.id})`;

  if (option.type === "boolean") {
    return (
      <label className="config-toggle" title={hint}>
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
    <label className="config-field" title={hint}>
      <span className="config-label">{option.name}</span>
      <select
        className="config-select"
        value={String(option.currentValue)}
        onChange={(e) => onChange(e.target.value)}
      >
        {option.options?.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.name}
          </option>
        ))}
      </select>
    </label>
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
