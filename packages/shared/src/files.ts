import type { KcEvent } from "./events.js";

/**
 * The Files pane: a read-only view of the directories a conversation is
 * about, served to the browser by the server rather than read by the agent.
 *
 * The roots are the session's working directory plus whatever the user has
 * added, which is why they come from the event log and not a request.
 */

export interface FileEntry {
  name: string;
  kind: "dir" | "file" | "other";
  /** Bytes; 0 for directories. */
  size: number;
  /** Matched by `.gitignore` (or is `.git` itself). Shown dimmed, never hidden. */
  ignored: boolean;
}

export interface FilesResponse {
  root: string;
  /** Relative to `root`, "" for the root itself. */
  path: string;
  entries: FileEntry[];
}

/** What the text endpoint says about a file. Images and PDFs use the raw route instead. */
export type FileContent =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "large"; size: number };

/** Text above this is not sent; the pane says how big it is instead. */
export const FILE_TEXT_LIMIT = 2 * 1024 * 1024;

/**
 * The directories a conversation may browse, replayed from its log. Adding
 * twice is once; removing something never added is nothing. The working
 * directory is always first and cannot be removed.
 */
export function collectRoots(cwd: string, events: ReadonlyArray<KcEvent>): string[] {
  const added: string[] = [];
  for (const event of events) {
    if (event.type === "root_added" && event.path !== cwd && !added.includes(event.path)) added.push(event.path);
    if (event.type === "root_removed") {
      const at = added.indexOf(event.path);
      if (at >= 0) added.splice(at, 1);
    }
  }
  return [cwd, ...added];
}
