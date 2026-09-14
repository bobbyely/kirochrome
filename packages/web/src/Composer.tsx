import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandOption, ConfigOption, FileEntry, SessionSummary, SlashCommand } from "@kirochrome/shared";
import { fetchDirectory } from "./api.js";
import { commonPrefix, complete } from "./commands.js";
import { completeMention, mentionAt, mentionPath, mentionedIn, splitMention } from "./mentions.js";
import { useReadyProviders } from "./useReadyProviders.js";
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
  onInterrupt,
  onCancel,
  onSetAutoApprove,
  onSetConfigOption,
  onSwitchProvider,
  onUnqueue,
  onEditQueued,
  onMoveQueued,
  roots,
}: {
  session: SessionSummary | null;
  busy: boolean;
  /** The conversation's directories, working directory first — what `@` completes against. */
  roots: string[];
  /** Agent-supplied argument suggestions, keyed by "command\u0000partial". */
  commandOptions: Record<string, CommandOption[]>;
  requestCommandOptions: (command: string, partial: string) => void;
  onPrompt: (text: string, images: Array<{ mime: string; data: string }>, files: string[]) => void;
  /** Like `onPrompt`, but cancels the running turn first. */
  onInterrupt: (text: string, images: Array<{ mime: string; data: string }>, files: string[]) => void;
  onCancel: () => void;
  onSetAutoApprove: (enabled: boolean) => void;
  onSetConfigOption: (configId: string, value: string | boolean) => void;
  onSwitchProvider: (providerId: string) => void;
  onUnqueue: (index: number) => void;
  onEditQueued: (index: number, text: string) => void;
  onMoveQueued: (from: number, to: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  /** Index of the highlighted command while the slash picker is open. */
  const [commandIndex, setCommandIndex] = useState(0);
  /** Paths picked from the `@` picker. Only these are sent as files; typed-by-hand `@` is prose. */
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  /** Directory listings the picker has fetched, by "root\0dir". */
  const [dirs, setDirs] = useState<Map<string, FileEntry[]>>(() => new Map());

  const queued = session?.queued ?? [];
  const canAttach = session?.supportsImages === true;

  const submit = (mode: "queue" | "now" = "queue") => {
    const text = draft.trim();
    // Deliberately allowed while busy: the server queues it and sends it when
    // the current turn ends — or, with "now", cuts the turn short for it.
    if (!text && images.length === 0) return;
    const send = mode === "now" ? onInterrupt : onPrompt;
    send(text, images.map(({ mime, data }) => ({ mime, data })), mentionedIn(text, chosen));
    setDraft("");
    setImages([]);
    setChosen(new Set());
  };

  // `@` completes against the directory the partial names: the working
  // directory for a relative one, whichever root contains an absolute one.
  // Listings come from the Files endpoint and are kept for the composer's life.
  const mention = mentionAt(draft);
  const cwd = roots[0] ?? "";
  const listing = useMemo(() => {
    if (!mention) return null;
    const { dir, absolute } = splitMention(mention.typed);
    const root = absolute ? roots.find((r) => dir === `${r}/` || dir.startsWith(`${r}/`)) : cwd;
    if (!root) return null;
    const rel = absolute ? dir.slice(root.length + 1) : dir;
    return { root, path: rel.replace(/\/$/, "") };
  }, [mention?.typed, roots, cwd]);
  const listingKey = listing ? `${listing.root}\0${listing.path}` : null;
  useEffect(() => {
    if (!listing || !listingKey || !session || dirs.has(listingKey)) return;
    let stale = false;
    fetchDirectory(session.id, listing.root, listing.path)
      .then((res) => !stale && setDirs((m) => new Map(m).set(listingKey, res.entries)))
      .catch(() => !stale && setDirs((m) => new Map(m).set(listingKey, [])));
    return () => {
      stale = true;
    };
  }, [listingKey, listing, session, dirs]);

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
    () =>
      mention
        ? completeMention(draft, mention, listingKey ? dirs.get(listingKey) : undefined, roots.slice(1))
        : complete(draft, session?.commands ?? [], agentOptions),
    [draft, mention, listingKey, dirs, roots, session?.commands, agentOptions],
  );
  const picking = matches.length > 0;
  const active = matches[Math.min(commandIndex, matches.length - 1)];

  const choose = (replacement: string) => {
    setDraft(replacement);
    setCommandIndex(0);
    const path = mentionPath(replacement);
    if (path) setChosen((prev) => new Set(prev).add(path));
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
              ? "Send a message — @ mentions a file, paste or drop an image"
              : "Send a message — @ mentions a file"
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
            // Cmd/Ctrl+Enter while the agent works: do not wait for it.
            submit((e.metaKey || e.ctrlKey) && busy ? "now" : "queue");
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
          {session?.live && <ProviderPicker session={session} busy={busy} onSwitch={onSwitchProvider} />}
          {session && pickableCommands(session).map((command) => (
            <CommandPicker
              key={command.name}
              command={command}
              options={commandOptions[`${command.name}\u0000`]}
              onOpen={() => requestCommandOptions(command.name, "")}
              onChoose={(value) => onPrompt(`/${command.name} ${value}`, [], [])}
            />
          ))}
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
          {busy && (
            <button
              onClick={() => submit("now")}
              disabled={!draft.trim() && images.length === 0}
              title="Cancel the current turn and send this now (Cmd/Ctrl+Enter). What the agent was doing is abandoned."
            >
              Interrupt &amp; send
            </button>
          )}
          <button
            className="primary"
            onClick={() => submit()}
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
 * Commands whose argument the agent enumerates, offered as pickers beside the
 * settings — but not where a setting already covers the same thing, which
 * would put two controls for one knob on the row. Matched by name against
 * option ids and categories; `agent` is what some CLIs call ACP's mode.
 */
function pickableCommands(session: SessionSummary): SlashCommand[] {
  const covered = new Set<string>();
  for (const option of session.configOptions) {
    covered.add(option.id);
    if (option.category) covered.add(option.category);
  }
  if (covered.has("mode")) covered.add("agent");
  return session.commands.filter((c) => c.selection && !covered.has(c.name));
}

/**
 * A command run as a picker: choosing a value sends `/name value` as an
 * ordinary prompt, which is how every command runs. Values are fetched from
 * the agent when the picker mounts and again when it is opened; the one the
 * agent marks current is shown selected, so the row reads like a setting.
 */
function CommandPicker({
  command,
  options,
  onOpen,
  onChoose,
}: {
  command: SlashCommand;
  options: CommandOption[] | undefined;
  onOpen: () => void;
  onChoose: (value: string) => void;
}) {
  const asked = useRef(false);
  useEffect(() => {
    if (options || asked.current) return;
    asked.current = true;
    onOpen();
  }, [options, onOpen]);
  // The agent's answer lags the click by a turn; show the choice at once.
  const [chosen, setChosen] = useState<string | null>(null);
  const current = chosen ?? options?.find((o) => o.current)?.value ?? "";
  return (
    <label className="config-field" title={`${command.description} (/${command.name})`}>
      <span className="config-label">{command.name}</span>
      <select
        className="config-select"
        value={current}
        onFocus={onOpen}
        onChange={(e) => {
          if (!e.target.value) return;
          setChosen(e.target.value);
          onChoose(e.target.value);
        }}
      >
        {!options && <option value="">…</option>}
        {options && !current && <option value="">choose…</option>}
        {options?.map((o) => (
          <option key={o.value} value={o.value} title={o.description}>
            {o.label || o.value}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * One agent-advertised setting, rendered from whatever the agent offers.
 * Never a hardcoded model list — see invariant 5 in AGENTS.md.
 */
/**
 * Provider first, before whatever that provider advertises. Only providers
 * whose check passed are offered (invariant 11); the current one is shown
 * even if it has since gone stale, since that is where the conversation is.
 * Disabled mid-turn: a switch would abandon what is in flight, and the
 * server refuses it anyway.
 */
function ProviderPicker({
  session,
  busy,
  onSwitch,
}: {
  session: SessionSummary;
  busy: boolean;
  onSwitch: (providerId: string) => void;
}) {
  const ready = useReadyProviders().providers ?? [];
  const choices = ready.some((p) => p.id === session.providerId)
    ? ready
    : [{ id: session.providerId, name: session.providerName }, ...ready];
  if (choices.length < 2) return null;
  const pending = session.awaitingInput || session.queued.length > 0;
  return (
    <label
      className="config-field"
      title={
        busy || pending
          ? "Wait for the turn to finish before switching"
          : "Move this conversation to another agent. It is given the transcript so far with your next message."
      }
    >
      <span className="config-label">Provider</span>
      <select
        className="config-select"
        value={session.providerId}
        disabled={busy || pending}
        onChange={(e) => onSwitch(e.target.value)}
      >
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

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
