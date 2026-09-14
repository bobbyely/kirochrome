import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { KcEvent } from "@kirochrome/shared";
import { collectChanges, relativeTo, type FileChange } from "./changes.js";
import { DiffView } from "./DiffView.js";

const WIDTH_KEY = "kc.changes.width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 560;
/** Never wider than this share of the window: the conversation must stay readable. */
const MAX_SHARE = 0.6;

const clampWidth = (width: number) => Math.round(Math.min(Math.max(width, MIN_WIDTH), window.innerWidth * MAX_SHARE));

function loadWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return clampWidth(stored > 0 ? stored : DEFAULT_WIDTH);
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * A pane beside the transcript listing every file the agent has changed this
 * conversation, from the diffs its tool calls reported — so it answers "what
 * did it do to my project" without hunting the transcript for the tool call
 * that did it. Click a file for its net diff: the file before the first edit
 * against after the last. Drag its left edge to resize; the width is kept
 * in this browser, which is a convenience and not conversation state.
 */
export function ChangesPane({ events, cwd, onClose }: { events: KcEvent[]; cwd: string; onClose: () => void }) {
  const changes = useMemo(() => collectChanges(events), [events]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [width, setWidth] = useState(loadWidth);
  const pane = useRef<HTMLDivElement>(null);

  // Pointer capture keeps the drag alive when the cursor outruns the handle.
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          // Nothing to do: the width just will not be remembered.
        }
        return w;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    pane.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  };

  const open = changes.find((c) => c.path === openPath);
  const totals = changes.reduce(
    (sum, c) => ({ added: sum.added + (c.added ?? 0), removed: sum.removed + (c.removed ?? 0) }),
    { added: 0, removed: 0 },
  );

  return (
    <aside
      className="changes"
      ref={pane}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Changes"
      style={{ flexBasis: width }}
    >
      <div className="changes-resize" onPointerDown={startResize} title="Drag to resize" />
      <div className="changes-head">
        <strong>Changes</strong>
        <span className="muted">
          {changes.length} file{changes.length === 1 ? "" : "s"}
          {changes.length > 0 && (
            <>
              {" "}
              · <span className="stat-add">+{totals.added}</span> <span className="stat-del">−{totals.removed}</span>
            </>
          )}
        </span>
        <button className="changes-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </div>

      {changes.length === 0 && (
        <p className="muted changes-empty">Nothing yet. Files the agent edits will be listed here as it reports them.</p>
      )}

      <ul className="changes-list">
        {changes.map((change) => (
          <li key={change.path}>
            <button
              className={`changes-file ${change.path === openPath ? "active" : ""}`}
              onClick={() => setOpenPath(change.path === openPath ? null : change.path)}
            >
              <code className="changes-path">{relativeTo(cwd, change.path)}</code>
              <Stat change={change} />
            </button>
          </li>
        ))}
      </ul>

      {open && (
        <div className="changes-diff">
          {open.net.oldText === "" && open.net.newText === "" ? (
            <p className="muted">
              <code>{relativeTo(cwd, open.path)}</code> was created empty, or the agent reported the edit without
              its content.
            </p>
          ) : (
            <DiffView diff={{ ...open.net, path: relativeTo(cwd, open.path) }} />
          )}
        </div>
      )}
    </aside>
  );
}

function Stat({ change }: { change: FileChange }) {
  return (
    <span className="changes-stat">
      {change.edits > 1 && <span className="muted">{change.edits}× </span>}
      {change.status !== "modified" && <span className={`changes-status ${change.status}`}>{change.status} </span>}
      {change.added === null ? (
        <span className="muted">large</span>
      ) : change.added === 0 && change.removed === 0 ? null : (
        <>
          <span className="stat-add">+{change.added}</span> <span className="stat-del">−{change.removed}</span>
        </>
      )}
    </span>
  );
}
