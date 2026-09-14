import { useMemo, useState } from "react";
import type { KcEvent } from "@kirochrome/shared";
import { collectChanges, relativeTo, type FileChange } from "./changes.js";
import { DiffView } from "./DiffView.js";

/**
 * The Changes tab: every file the agent has changed this conversation, from
 * the diffs its tool calls reported — so it answers "what did it do to my
 * project" without hunting the transcript for the tool call that did it.
 * Click a file for its net diff: the file before the first edit against
 * after the last.
 */
export function ChangesPane({ events, cwd }: { events: KcEvent[]; cwd: string }) {
  const changes = useMemo(() => collectChanges(events), [events]);
  const [openPath, setOpenPath] = useState<string | null>(null);

  const open = changes.find((c) => c.path === openPath);
  const totals = changes.reduce(
    (sum, c) => ({ added: sum.added + (c.added ?? 0), removed: sum.removed + (c.removed ?? 0) }),
    { added: 0, removed: 0 },
  );

  return (
    <>
      {changes.length > 0 && (
        <div className="changes-summary muted">
          {changes.length} file{changes.length === 1 ? "" : "s"} · <span className="stat-add">+{totals.added}</span>{" "}
          <span className="stat-del">−{totals.removed}</span>
        </div>
      )}

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
    </>
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
