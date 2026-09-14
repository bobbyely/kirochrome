import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { collectRoots, type FileContent, type FileEntry, type KcEvent } from "@kirochrome/shared";
import { ApiError, fetchDirectory, fetchFile, rawFileUrl, setRoot } from "./api.js";
import { highlightLine } from "./DiffView.js";
import { formatSize, isRaw, parseDelimited, prettyJson, TABLE_ROW_LIMIT, viewerFor, whyNotOpenable } from "./files.js";
import { MarkdownBody } from "./Markdown.js";
import { languageFor } from "./timeline.js";

/** Files with more lines than this are shown plain: highlighting a line at a time is fine up to here. */
const HIGHLIGHT_LINE_LIMIT = 5_000;

interface Selected {
  root: string;
  path: string;
}

/** One directory's listing as the tree holds it: loading, loaded, or why not. */
type Listing = { state: "loading" } | { state: "ok"; entries: FileEntry[] } | { state: "error"; message: string };

const key = (root: string, path: string) => `${root}\0${path}`;
const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/**
 * The Files tab: what is on disk in the conversation's directories, read-only.
 *
 * The roots are replayed from the event log — the working directory plus
 * every `root_added` — so the tree and the server agree on what may be shown
 * without the browser holding a list of its own. Which directories are
 * expanded, and which file is open, are this browser's business.
 */
export function FilesPane({ sessionId, cwd, events, live }: { sessionId: string; cwd: string; events: KcEvent[]; live: boolean }) {
  const roots = useMemo(() => collectRoots(cwd, events), [cwd, events]);
  const [listings, setListings] = useState<Map<string, Listing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([key(cwd, "")]));
  const [selected, setSelected] = useState<Selected | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);

  const load = useCallback(
    async (root: string, path: string) => {
      setListings((m) => new Map(m).set(key(root, path), { state: "loading" }));
      let listing: Listing;
      try {
        const { entries } = await fetchDirectory(sessionId, root, path);
        listing = { state: "ok", entries };
      } catch (err) {
        listing = { state: "error", message: err instanceof ApiError ? err.kc.message : String(err) };
      }
      setListings((m) => new Map(m).set(key(root, path), listing));
    },
    [sessionId],
  );

  // Anything expanded and not yet listed gets fetched: the first root on
  // open, a directory on click, a root that was just added.
  useEffect(() => {
    for (const k of expanded) {
      if (listings.has(k)) continue;
      const [root, path] = k.split("\0") as [string, string];
      if (roots.includes(root)) void load(root, path);
    }
  }, [expanded, listings, roots, load]);

  const toggle = (root: string, path: string) => {
    const k = key(root, path);
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  /** Forgets every listing under a root, so it is read again on the next look. */
  const refresh = (root: string) => {
    setListings((m) => {
      const next = new Map(m);
      for (const k of next.keys()) if (k.startsWith(`${root}\0`)) next.delete(k);
      return next;
    });
  };

  const onAddRoot = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const path = (new FormData(form).get("path") as string).trim();
    if (!path) return;
    setRootError(null);
    try {
      await setRoot(sessionId, path, true);
      form.reset();
      setExpanded((s) => new Set(s).add(key(path, "")));
    } catch (err) {
      const kc = err instanceof ApiError ? err.kc : null;
      setRootError(kc ? `${kc.message}${kc.remediation ? ` ${kc.remediation}` : ""}` : String(err));
    }
  };

  const onRemoveRoot = async (path: string) => {
    setRootError(null);
    try {
      await setRoot(sessionId, path, false);
      if (selected?.root === path) setSelected(null);
    } catch (err) {
      setRootError(err instanceof ApiError ? err.kc.message : String(err));
    }
  };

  return (
    <>
      <div className="files-tree">
        {roots.map((root) => (
          <div key={root} className="files-root">
            <div className="files-row files-root-row" title={root}>
              <button className="files-toggle" onClick={() => toggle(root, "")} aria-expanded={expanded.has(key(root, ""))}>
                {expanded.has(key(root, "")) ? "▾" : "▸"}
              </button>
              <span className="files-name">{basename(root)}</span>
              <button className="files-action" onClick={() => refresh(root)} title="Read this directory again">
                ↻
              </button>
              {root !== cwd && (
                <button className="files-action" onClick={() => void onRemoveRoot(root)} title="Remove from the pane" disabled={!live}>
                  ×
                </button>
              )}
            </div>
            {expanded.has(key(root, "")) && (
              <Directory root={root} path="" depth={1} listings={listings} expanded={expanded} selected={selected} onToggle={toggle} onSelect={setSelected} />
            )}
          </div>
        ))}
        <form className="files-add" onSubmit={(e) => void onAddRoot(e)}>
          <input name="path" placeholder="Add a directory (absolute path)" disabled={!live} title={live ? "" : "Resume the conversation to add a directory"} />
          <button type="submit" disabled={!live}>
            Add
          </button>
        </form>
        {rootError && <p className="files-error">{rootError}</p>}
        <p className="files-hint muted">Added directories are for you to browse; the agent sees only its working directory unless you tell it a path.</p>
      </div>
      <div className="files-view">
        {selected ? <Viewer sessionId={sessionId} selected={selected} /> : <p className="muted changes-empty">Pick a file to read it.</p>}
      </div>
    </>
  );
}

function Directory({
  root,
  path,
  depth,
  listings,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  root: string;
  path: string;
  depth: number;
  listings: Map<string, Listing>;
  expanded: Set<string>;
  selected: Selected | null;
  onToggle: (root: string, path: string) => void;
  onSelect: (s: Selected) => void;
}) {
  const listing = listings.get(key(root, path));
  const indent = { paddingLeft: `${depth * 14}px` };
  if (!listing || listing.state === "loading") return <div className="files-row muted" style={indent}>…</div>;
  if (listing.state === "error") return <div className="files-row files-error" style={indent}>{listing.message}</div>;
  if (listing.entries.length === 0) return <div className="files-row muted" style={indent}>(empty)</div>;

  return (
    <>
      {listing.entries.map((entry) => {
        const child = path ? `${path}/${entry.name}` : entry.name;
        const k = key(root, child);
        const isOpen = expanded.has(k);
        const isSelected = selected?.root === root && selected.path === child;
        const why = whyNotOpenable(entry);
        return (
          <div key={entry.name}>
            <div
              className={`files-row ${entry.ignored ? "ignored" : ""} ${isSelected ? "active" : ""}`}
              style={indent}
              title={why ?? (entry.kind === "file" ? formatSize(entry.size) : undefined)}
            >
              {entry.kind === "dir" ? (
                <button className="files-toggle" onClick={() => onToggle(root, child)} aria-expanded={isOpen}>
                  {isOpen ? "▾" : "▸"}
                </button>
              ) : (
                <span className="files-toggle" />
              )}
              {entry.kind === "file" ? (
                <button className="files-name files-file" onClick={() => onSelect({ root, path: child })}>
                  {entry.name}
                </button>
              ) : (
                <span className={`files-name ${entry.kind === "other" ? "muted" : ""}`}>{entry.name}</span>
              )}
            </div>
            {entry.kind === "dir" && isOpen && (
              <Directory root={root} path={child} depth={depth + 1} listings={listings} expanded={expanded} selected={selected} onToggle={onToggle} onSelect={onSelect} />
            )}
          </div>
        );
      })}
    </>
  );
}

// ---------- the viewer ----------

type Loaded = { state: "loading" } | { state: "ok"; content: FileContent } | { state: "error"; message: string };

/** Each format shown the way it is meant to be read; never a dump of bytes. */
function Viewer({ sessionId, selected }: { sessionId: string; selected: Selected }) {
  const { root, path } = selected;
  const name = basename(path);
  const viewer = viewerFor(name);
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (isRaw(name)) return; // the browser fetches these itself, from the URL
    let stale = false;
    setLoaded({ state: "loading" });
    fetchFile(sessionId, root, path)
      .then((content) => !stale && setLoaded({ state: "ok", content }))
      .catch((err: unknown) => !stale && setLoaded({ state: "error", message: err instanceof ApiError ? err.kc.message : String(err) }));
    return () => {
      stale = true;
    };
  }, [sessionId, root, path, name]);

  const head = (
    <div className="files-view-head">
      <code className="changes-path" title={`${root}/${path}`}>
        {path}
      </code>
      {viewer === "markdown" && loaded.state === "ok" && loaded.content.kind === "text" && (
        <button className="files-action" onClick={() => setShowSource((v) => !v)}>
          {showSource ? "Rendered" : "Source"}
        </button>
      )}
    </div>
  );

  if (viewer === "image") {
    return (
      <>
        {head}
        <div className="files-body files-media">
          <img src={rawFileUrl(sessionId, root, path)} alt={name} />
        </div>
      </>
    );
  }
  if (viewer === "pdf") {
    return (
      <>
        {head}
        <iframe className="files-body files-pdf" src={rawFileUrl(sessionId, root, path)} title={name} />
      </>
    );
  }
  if (loaded.state === "loading") return <>{head}<p className="muted changes-empty">Reading…</p></>;
  if (loaded.state === "error") return <>{head}<p className="files-error changes-empty">{loaded.message}</p></>;
  const { content } = loaded;
  if (content.kind === "binary") return <>{head}<p className="muted changes-empty">Binary, {formatSize(content.size)}. Not shown.</p></>;
  if (content.kind === "large") return <>{head}<p className="muted changes-empty">{formatSize(content.size)} of text — too large to show here.</p></>;

  return (
    <>
      {head}
      <div className="files-body">
        <Text name={name} text={content.content} viewer={viewer} showSource={showSource} />
      </div>
    </>
  );
}

function Text({ name, text, viewer, showSource }: { name: string; text: string; viewer: ReturnType<typeof viewerFor>; showSource: boolean }) {
  if (viewer === "markdown" && !showSource) return <MarkdownBody>{text}</MarkdownBody>;
  if (viewer === "table") {
    const { rows, total } = parseDelimited(text, name.toLowerCase().endsWith(".tsv") ? "\t" : ",");
    return <Table rows={rows} total={total} />;
  }
  if (viewer === "json") {
    const pretty = prettyJson(text);
    return <Code text={pretty ?? text} language="json" />;
  }
  return <Code text={text} language={languageFor(name)} />;
}

/** Highlighted a line at a time, as the diff view does, with line numbers in a column that does not copy. */
function Code({ text, language }: { text: string; language: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const highlight = lines.length <= HIGHLIGHT_LINE_LIMIT;
  return (
    <pre className="files-code">
      {lines.map((line, i) => (
        <div key={i} className="files-line">
          <span className="files-ln" aria-hidden="true">
            {i + 1}
          </span>
          {highlight ? (
            // highlight.js escapes the text itself; see DiffView.
            <span className="files-src" dangerouslySetInnerHTML={{ __html: highlightLine(line, language) }} />
          ) : (
            <span className="files-src">{line}</span>
          )}
        </div>
      ))}
    </pre>
  );
}

function Table({ rows, total }: { rows: string[][]; total: number }) {
  const [header, ...body] = rows;
  if (!header) return <p className="muted">Empty.</p>;
  return (
    <>
      <table className="files-table">
        <thead>
          <tr>{header.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {total > TABLE_ROW_LIMIT && <p className="muted">Showing the first {TABLE_ROW_LIMIT} of {total} rows.</p>}
    </>
  );
}
