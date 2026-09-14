import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { KcEvent } from "@kirochrome/shared";
import { collectChanges, type FileChange } from "./changes.js";
import { DiffView } from "./DiffView.js";

/**
 * A drawer over the transcript listing every file the agent has changed this
 * conversation, from the diffs its tool calls reported — so it answers "what
 * did it do to my project" without hunting the transcript for the tool call
 * that did it. Click a file for its net diff: the file before the first edit
 * against after the last.
 */
export function ChangesPane({ events, onClose }: { events: KcEvent[]; onClose: () => void }) {
  const changes = useMemo(() => collectChanges(events), [events]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const pane = useRef<HTMLDivElement>(null);

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
    <aside className="changes" ref={pane} tabIndex={-1} onKeyDown={onKeyDown} aria-label="Changes">
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
              <code className="changes-path">{change.path}</code>
              <Stat change={change} />
            </button>
          </li>
        ))}
      </ul>

      {open && (
        <div className="changes-diff">
          <DiffView diff={open.net} />
        </div>
      )}
    </aside>
  );
}

function Stat({ change }: { change: FileChange }) {
  return (
    <span className="changes-stat">
      {change.edits > 1 && <span className="muted">{change.edits}× </span>}
      {change.added === null ? (
        <span className="muted">large</span>
      ) : (
        <>
          <span className="stat-add">+{change.added}</span> <span className="stat-del">−{change.removed}</span>
        </>
      )}
    </span>
  );
}
