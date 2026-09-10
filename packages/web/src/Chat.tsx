import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isProviderFault, latestUsage } from "@kirochrome/shared";
import type {
  ElicitationAction,
  ElicitationField,
  ElicitationValue,
  SessionUsage,
} from "@kirochrome/shared";
import { Composer } from "./Composer.js";
import { KSpinner } from "./KSpinner.js";
import { MarkdownBody } from "./Markdown.js";
import { collapseContext, countChanges, lineDiff } from "./diff.js";
import { buildRows, languageFor, toolContent, toolSubtitle, type Row, type ToolDiff } from "./timeline.js";
import { useChat } from "./useChat.js";

/** Rows rendered initially, and how many more each "show earlier" adds. */
const INITIAL_ROWS = 60;
const MORE_ROWS = 60;

export function Chat({
  providerId,
  cwd,
  sessionId,
  adopt,
  onStarted,
  onOpenSetup,
}: {
  providerId?: string;
  cwd?: string;
  sessionId?: string;
  /** A conversation the agent already had, being taken over for the first time. */
  adopt?: { agentSessionId: string; cwd: string; title: string | null };
  onStarted?: () => void;
  onOpenSetup?: () => void;
}) {
  const {
    connected,
    session,
    events,
    error,
    openSession,
    adoptSession,
    attachSession,
    resumeSession,
    setConfigOption,
    answerPermission,
    answerElicitation,
    setAutoApprove,
    unqueue,
    commandOptions,
    requestCommandOptions,
    editQueued,
    moveQueued,
    prompt,
    cancel,
  } = useChat();

  /** Whether the view is following new output, or the reader has scrolled away. */
  const [following, setFollowing] = useState(true);
  const transcript = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  /** The conversation already asked for, so a re-render does not ask twice. */
  const attached = useRef<string | null>(null);

  // This component is not remounted per conversation, so attaching is driven by
  // the target changing rather than by mounting. A dropped socket re-subscribes
  // itself from its high-water mark, which is why this does not run again on
  // reconnect.
  useEffect(() => {
    if (!connected) return;
    const target =
      sessionId ??
      (adopt ? `adopt:${providerId}:${adopt.agentSessionId}` : `new:${providerId}:${cwd}`);
    if (attached.current === target) return;
    attached.current = target;
    if (sessionId) attachSession(sessionId);
    else if (providerId && adopt) adoptSession(providerId, adopt);
    else if (providerId) openSession(providerId, cwd);
  }, [connected, openSession, adoptSession, attachSession, providerId, cwd, sessionId, adopt]);

  const allRows = useMemo(() => buildRows(events), [events]);
  const [windowSize, setWindowSize] = useState(INITIAL_ROWS);

  // Long conversations render every row otherwise, and each agent message is a
  // full markdown parse. Show the most recent slice and let the reader ask for
  // more, which avoids a virtualisation library for a list this shape.
  const hidden = Math.max(0, allRows.length - windowSize);
  const rows = hidden > 0 ? allRows.slice(hidden) : allRows;
  const usage = useMemo(() => latestUsage(events), [events]);

  // Changes as text streams into the last row, not just when a row is added —
  // otherwise a long reply scrolls once and then stops following.
  const tail = rows.at(-1);
  const growth = `${rows.length}:${tail && "text" in tail ? tail.text.length : 0}`;

  /** Cleared on switch: the first scroll into a conversation must not animate. */
  const landed = useRef(false);

  useLayoutEffect(() => {
    // Only follow if the reader is already at the bottom. Yanking them back
    // while they are reading earlier output is worse than not scrolling.
    if (!following) return;
    // Smooth is for output arriving while you watch. On arrival it is a visible
    // crawl from the top of the backlog, so the first scroll jumps instead —
    // before paint, so the top is never shown.
    bottom.current?.scrollIntoView({ behavior: landed.current ? "smooth" : "auto", block: "end" });
    if (rows.length > 0) landed.current = true;
  }, [growth, following, rows.length]);

  const onScroll = () => {
    const el = transcript.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setFollowing(distanceFromBottom < 120);
  };

  const jumpToLatest = () => {
    setFollowing(true);
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  // A conversation switched to should not inherit the previous one's expanded
  // window, scroll position or reading state. The component survives the
  // switch now, so this is reset rather than a fresh mount.
  useEffect(() => {
    setWindowSize(INITIAL_ROWS);
    setFollowing(true);
    landed.current = false;
  }, [sessionId, providerId, adopt?.agentSessionId]);

  useEffect(() => {
    if (session?.live) onStarted?.();
  }, [session?.live, onStarted]);

  const busy = session?.busy ?? false;
  // A session read back from disk has no agent attached until it is resumed.
  const readOnly = session !== null && !session.live;

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
        {/* Live sessions always show it; a restored one shows it whenever its
            log holds usage, since that history is still meaningful. */}
        {(session?.live || usage) && <ContextMeter usage={usage} />}
        <span className={`pill ${connected ? "pill-ok" : "pill-stale"}`}>
          {connected ? "Connected" : "Reconnecting…"}
        </span>
      </header>

      <div className="transcript" ref={transcript} onScroll={onScroll}>
        {/* Inner wrapper caps line length; alignment happens inside it, so
            user messages can still sit right while the column stays centred. */}
        <div className="transcript-inner">
          {!session && <p className="muted">{sessionId ? "Loading conversation…" : "Starting agent…"}</p>}
          {hidden > 0 && (
            <button className="show-earlier" onClick={() => setWindowSize((n) => n + MORE_ROWS)}>
              Show earlier messages ({hidden} hidden)
            </button>
          )}
          {rows.map((row) => (
            <Message
              key={row.seq}
              row={row}
              onPermission={answerPermission}
              onElicitation={answerElicitation}
            />
          ))}
          {busy && (
            <div className="thinking">
              <KSpinner label={session?.awaitingInput ? "Waiting for you" : "Working"} />
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>

      {!following && (
        <button className="jump-latest" onClick={jumpToLatest}>
          Jump to latest ↓
        </button>
      )}

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
        <Composer
          // Keyed so a half-typed message and its pasted images do not follow
          // the reader into the next conversation.
          key={session?.id ?? "new"}
          session={session}
          busy={busy}
          commandOptions={commandOptions}
          requestCommandOptions={requestCommandOptions}
          onPrompt={prompt}
          onCancel={cancel}
          onSetAutoApprove={setAutoApprove}
          onSetConfigOption={setConfigOption}
          onUnqueue={unqueue}
          onEditQueued={editQueued}
          onMoveQueued={moveQueued}
        />
      )}
    </div>
  );
}

/**
 * One transcript row.
 *
 * Memoized because rendering a row is expensive — a prose row parses markdown
 * and highlights every code block — while its props are referentially stable:
 * `buildRows` is memoized on the event log, and the two handlers come from
 * `useChat` as `useCallback`s over a `send` that never changes. So anything
 * re-rendering `Chat` without new events bails out here instead of re-parsing
 * the whole visible transcript.
 */
const Message = memo(function Message({
  row,
  onPermission,
  onElicitation,
}: {
  row: Row;
  onPermission: (requestId: string, optionId: string | null) => void;
  onElicitation: AnswerElicitation;
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
    case "elicitation":
      return <ElicitationCard row={row} onAnswer={onElicitation} />;
    case "note":
      return <div className="msg msg-note">{row.label}</div>;
    case "compaction":
      return <CompactionRow row={row} />;
    case "adopted":
      return <AdoptedRow row={row} />;
    case "work":
      return <WorkGroup row={row} onPermission={onPermission} onElicitation={onElicitation} />;
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
});

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
  onElicitation,
}: {
  row: Extract<Row, { kind: "work" }>;
  onPermission: (requestId: string, optionId: string | null) => void;
  onElicitation: AnswerElicitation;
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
          <Message
            key={child.seq}
            row={child}
            onPermission={onPermission}
            onElicitation={onElicitation}
          />
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

const COMPACTION_LABEL: Record<string, string> = {
  in_progress: "Compacting context…",
  completed: "Context compacted",
  failed: "Compaction failed",
  cancelled: "Compaction cancelled",
};

/**
 * Where the agent replaced history with a summary.
 *
 * Shown in the transcript at the point it happened, because that is where the
 * conversation above it stopped being what the model can see. The summary is
 * the agent's own, so it is worth being able to read.
 */
function CompactionRow({ row }: { row: Extract<Row, { kind: "compaction" }> }) {
  const label = COMPACTION_LABEL[row.status] ?? `Compaction: ${row.status}`;
  const detail = row.error ?? row.summary;

  return (
    <div className={`compaction compaction-${row.status}`}>
      <span className="compaction-rule" />
      {detail ? (
        <details className="compaction-body">
          <summary>{label}</summary>
          {row.error ? <p className="remediation">{row.error}</p> : <MarkdownBody>{row.summary}</MarkdownBody>}
        </details>
      ) : (
        <span className="compaction-label">{label}</span>
      )}
      <span className="compaction-rule" />
    </div>
  );
}

/**
 * Where a conversation started in the agent's own CLI was taken over.
 *
 * Says so plainly, because the transcript above the seam is whatever the agent
 * chose to replay and KiroChrome never saw it happen — it may be shorter than
 * the real conversation, and it holds no tool output we recorded ourselves.
 */
function AdoptedRow({ row }: { row: Extract<Row, { kind: "adopted" }> }) {
  return (
    <div className="compaction compaction-adopted">
      <span className="compaction-rule" />
      <details className="compaction-body">
        <summary>Adopted from {row.providerName}</summary>
        <p className="remediation">
          Everything above this line was replayed by {row.providerName} when this conversation was
          opened here, so it is the agent&rsquo;s own record rather than KiroChrome&rsquo;s.
          KiroChrome&rsquo;s log starts below it.
        </p>
      </details>
      <span className="compaction-rule" />
    </div>
  );
}

type AnswerElicitation = (
  requestId: string,
  action: ElicitationAction,
  content?: Record<string, ElicitationValue>,
) => void;

/** ACP string formats map onto input types the browser already validates. */
const FORMAT_INPUT: Record<string, string> = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
};

/**
 * A structured question from the agent, rendered as a form.
 *
 * Uncontrolled on purpose: the values live in the DOM until submit, so typing
 * an answer does not re-render the transcript, and `required`, `pattern` and
 * `min`/`max` are enforced by the browser rather than by hand. The server
 * re-checks everything anyway — the browser is not authoritative.
 */
function ElicitationCard({
  row,
  onAnswer,
}: {
  row: Extract<Row, { kind: "elicitation" }>;
  onAnswer: AnswerElicitation;
}) {
  if (row.answer) {
    const { action, content } = row.answer;
    return (
      <div className="elicitation answered">
        <div className="elicitation-head">{row.title ?? row.message}</div>
        <span className="muted">
          {action === "accept"
            ? Object.entries(content ?? {})
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
                .join(" · ") || "Answered"
            : action === "decline"
              ? "Declined"
              : "Cancelled"}
        </span>
      </div>
    );
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const content: Record<string, ElicitationValue> = {};

    for (const field of row.fields) {
      if (field.type === "multiselect") {
        content[field.key] = data.getAll(field.key).map(String);
        continue;
      }
      if (field.type === "boolean") {
        // An unchecked box sends nothing, and "false" is the answer, not silence.
        content[field.key] = data.get(field.key) !== null;
        continue;
      }
      const raw = data.get(field.key);
      if (typeof raw !== "string" || raw === "") continue;
      if (field.type === "number") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) content[field.key] = parsed;
        continue;
      }
      content[field.key] = raw;
    }
    onAnswer(row.requestId, "accept", content);
  };

  return (
    <form className="elicitation" onSubmit={submit}>
      <div className="elicitation-head">{row.title ?? "The agent has a question"}</div>
      <p className="elicitation-message">{row.message}</p>

      {row.fields.map((field) => (
        <label key={field.key} className="elicitation-field">
          <span className="elicitation-label">
            {field.label}
            {field.required && <span className="required">*</span>}
          </span>
          {field.description && <span className="muted">{field.description}</span>}
          <ElicitationInput field={field} />
        </label>
      ))}

      <div className="elicitation-actions">
        <button type="submit" className="primary">Send</button>
        <button type="button" onClick={() => onAnswer(row.requestId, "decline")}>
          Decline
        </button>
      </div>
    </form>
  );
}

function ElicitationInput({ field }: { field: ElicitationField }) {
  switch (field.type) {
    case "boolean":
      return <input type="checkbox" name={field.key} defaultChecked={field.default ?? false} />;

    case "number":
      return (
        <input
          type="number"
          name={field.key}
          required={field.required}
          step={field.integer ? 1 : "any"}
          min={field.minimum}
          max={field.maximum}
          defaultValue={field.default}
        />
      );

    case "select":
      return (
        <select name={field.key} required={field.required} defaultValue={field.default ?? ""}>
          {/* An optional question needs a way to answer nothing. */}
          {!field.required && <option value="">—</option>}
          {field.choices.map((choice) => (
            <option key={choice.value} value={choice.value} title={choice.description}>
              {choice.label}
            </option>
          ))}
        </select>
      );

    case "multiselect":
      return (
        <span className="elicitation-choices">
          {field.choices.map((choice) => (
            <label key={choice.value} className="elicitation-choice">
              <input
                type="checkbox"
                name={field.key}
                value={choice.value}
                defaultChecked={field.default?.includes(choice.value) ?? false}
              />
              {choice.label}
            </label>
          ))}
        </span>
      );

    case "text":
      return (
        <input
          type={FORMAT_INPUT[field.format ?? ""] ?? "text"}
          name={field.key}
          required={field.required}
          minLength={field.minLength}
          maxLength={field.maxLength}
          pattern={field.pattern}
          defaultValue={field.default}
        />
      );
  }
}

/**
 * Context window remaining, read out of the log's usage updates.
 *
 * Always rendered for a live session, showing "—" until the agent reports
 * usage: an absent meter is indistinguishable from a broken one, and not every
 * agent sends `usage_update` at all.
 */
function ContextMeter({ usage }: { usage: SessionUsage | null }) {
  if (!usage || usage.size <= 0) {
    return (
      <div className="context-meter" title="This agent has not reported context usage">
        <span className="context-label">context</span>
        <span className="context-pct">—</span>
      </div>
    );
  }

  const { used, size, cost } = usage;
  const usedPct = Math.min(100, Math.round((used / size) * 100));
  const leftPct = 100 - usedPct;
  const money =
    cost &&
    new Intl.NumberFormat(undefined, { style: "currency", currency: cost.currency }).format(cost.amount);

  const title =
    `${(size - used).toLocaleString()} of ${size.toLocaleString()} tokens left ` +
    `(${used.toLocaleString()} used)${money ? ` · ${money}` : ""}`;

  return (
    <div className="context-meter" title={title}>
      <span className="context-label">context</span>
      <div className="context-bar">
        {/* The bar fills as the window is consumed; the number says what is left. */}
        <div className={`context-fill ${usedPct >= 85 ? "high" : ""}`} style={{ width: `${usedPct}%` }} />
      </div>
      <span className={`context-pct ${leftPct <= 15 ? "low" : ""}`}>{leftPct}% left</span>
    </div>
  );
}
