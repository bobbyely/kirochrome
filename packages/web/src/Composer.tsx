import { useEffect, useMemo, useState } from "react";
import type { CommandOption, ConfigOption, SessionSummary } from "@kirochrome/shared";
import { commonPrefix, complete } from "./commands.js";
import { fileToImage, type PendingImage } from "./images.js";

/**
 * The message box and everything that belongs to it.
 *
 * Split out of `Chat` for a reason that is not tidiness: `draft` changes on
 * every keystroke, and while it lived in `Chat` each character re-rendered the
 * whole transcript — up to 60 rows, every prose row re-parsing its markdown and
 * re-highlighting its code. Keeping the fast-changing state in a sibling of the
 * transcript rather than its parent is what stops that at the source.
 */
export function Composer({
  session,
  busy,
  commandOptions,
  requestCommandOptions,
  onPrompt,
  onCancel,
  onSetAutoApprove,
  onSetConfigOption,
  onUnqueue,
  onEditQueued,
  onMoveQueued,
}: {
  session: SessionSummary | null;
  busy: boolean;
  /** Agent-supplied argument suggestions, keyed by "command\u0000partial". */
  commandOptions: Record<string, CommandOption[]>;
  requestCommandOptions: (command: string, partial: string) => void;
  onPrompt: (text: string, images: Array<{ mime: string; data: string }>) => void;
  onCancel: () => void;
  onSetAutoApprove: (enabled: boolean) => void;
  onSetConfigOption: (configId: string, value: string | boolean) => void;
  onUnqueue: (index: number) => void;
  onEditQueued: (index: number, text: string) => void;
  onMoveQueued: (from: number, to: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  /** Index of the highlighted command while the slash picker is open. */
  const [commandIndex, setCommandIndex] = useState(0);

  const queued = session?.queued ?? [];
  const canAttach = session?.supportsImages === true;

  const submit = () => {
    const text = draft.trim();
    // Deliberately allowed while busy: the server queues it and sends it when
    // the current turn ends.
    if (!text && images.length === 0) return;
    onPrompt(text, images.map(({ mime, data }) => ({ mime, data })));
    setDraft("");
    setImages([]);
  };

  // Ask the agent for real suggestions while an argument is being typed. It may
  // not support it, in which case nothing comes back and the hint-derived
  // values below stand on their own.
  const argPhase = /^\/(\S+)\s+(\S*)$/.exec(draft);
  useEffect(() => {
    if (argPhase) requestCommandOptions(argPhase[1]!, argPhase[2] ?? "");
  }, [argPhase?.[1], argPhase?.[2], requestCommandOptions]);

  // Terminal-style completion: command names first, then their arguments.
  const agentOptions = argPhase ? commandOptions[`${argPhase[1]}\u0000${argPhase[2] ?? ""}`] : undefined;
  const matches = useMemo(
    () => complete(draft, session?.commands ?? [], agentOptions),
    [draft, session?.commands, agentOptions],
  );
  const picking = matches.length > 0;
  const active = matches[Math.min(commandIndex, matches.length - 1)];

  const choose = (replacement: string) => {
    setDraft(replacement);
    setCommandIndex(0);
  };

  /**
   * Tab behaves like a shell: complete to the longest shared prefix when the
   * choice is ambiguous, and only commit when it is not.
   */
  const tabComplete = () => {
    if (matches.length === 1) return choose(matches[0]!.replacement);
    const shared = commonPrefix(matches.map((m) => m.replacement));
    if (shared.length > draft.length) choose(shared);
  };

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
    <div className="composer">
      {queued.length > 0 && (
        <div className="queued">
          <span className="queued-label">Queued ({queued.length})</span>
          {queued.map((text, i) => (
            <QueuedItem
              key={`${i}-${text}`}
              text={text}
              index={i}
              total={queued.length}
              onEdit={(next) => onEditQueued(i, next)}
              onMove={(delta) => onMoveQueued(i, i + delta)}
              onRemove={() => onUnqueue(i)}
            />
          ))}
        </div>
      )}
      {picking && (
        <div className="commands">
          {matches.map((match, i) => (
            <button
              key={match.replacement}
              className={`command ${match === active ? "on" : ""}`}
              onMouseEnter={() => setCommandIndex(i)}
              onClick={() => choose(match.replacement)}
            >
              <span className="command-name">{match.label}</span>
              <span className="command-desc">{match.detail}</span>
              {match.hint && <span className="command-hint">{match.hint}</span>}
            </button>
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
          if (picking) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const delta = e.key === "ArrowDown" ? 1 : -1;
              setCommandIndex((i) => (i + delta + matches.length) % matches.length);
              return;
            }
            if (e.key === "Tab") {
              e.preventDefault();
              tabComplete();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && active) {
              e.preventDefault();
              choose(active.replacement);
              return;
            }
            if (e.key === "Escape") {
              setDraft("");
              return;
            }
          }
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
                onChange={(e) => onSetAutoApprove(e.target.checked)}
              />
              Auto-approve
            </label>
          )}
          {session?.configOptions.map((option) => (
            <ConfigPicker
              key={option.id}
              option={option}
              onChange={(value) => onSetConfigOption(option.id, value)}
            />
          ))}
        </div>
        <div className="composer-buttons">
          {busy && <button onClick={onCancel}>Stop</button>}
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
  );
}

/** A message waiting to send: editable and reorderable until its turn comes. */
function QueuedItem({
  text,
  index,
  total,
  onEdit,
  onMove,
  onRemove,
}: {
  text: string;
  index: number;
  total: number;
  onEdit: (text: string) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== text) onEdit(draft);
  };

  if (editing) {
    return (
      <input
        className="queued-edit"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(text);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <div className="queued-item">
      <span className="queued-text" title={text}>
        {text}
      </span>
      <button aria-label="Move up" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
        ↑
      </button>
      <button
        aria-label="Move down"
        title="Move down"
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
      <button aria-label="Edit queued message" title="Edit" onClick={() => { setDraft(text); setEditing(true); }}>
        ✎
      </button>
      <button className="queued-remove" aria-label="Remove queued message" title="Remove" onClick={onRemove}>
        ×
      </button>
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
