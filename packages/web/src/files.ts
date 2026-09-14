import type { FileEntry } from "@kirochrome/shared";

/**
 * The pure half of the Files pane: which viewer a file gets, and the small
 * parsers the viewers need. No fetching, no React, so it can be tested as
 * plain TypeScript like `changes.ts`.
 */

export type Viewer = "image" | "pdf" | "markdown" | "table" | "json" | "code";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** Chosen by extension; the server decides text-versus-binary for the rest. */
export function viewerFor(name: string): Viewer {
  const ext = extensionOf(name);
  if (IMAGE.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "table";
  if (ext === "json") return "json";
  return "code";
}

/** Whether the raw route serves it (images and PDFs); everything else is read as text. */
export const isRaw = (name: string): boolean => viewerFor(name) === "image" || viewerFor(name) === "pdf";

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** "1.2 MB", "340 KB", "12 B". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pretty-printed, or null when it does not parse — then it is shown as it is, highlighted as JSON. */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Rows above this are not rendered; the viewer says how many there were. */
export const TABLE_ROW_LIMIT = 500;

/**
 * RFC 4180 as far as it goes: a quoted field may hold the delimiter, a
 * newline, and a doubled quote. Tabs for `.tsv`. Enough for the CSVs people
 * keep in repositories, which is what this shows; not a data pipeline.
 */
export function parseDelimited(text: string, delimiter: "," | "\t"): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let total = 0;

  const endRow = () => {
    row.push(field);
    field = "";
    // A trailing newline is not an empty row.
    if (row.length > 1 || row[0] !== "") {
      total += 1;
      if (rows.length < TABLE_ROW_LIMIT) rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") endRow();
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, total };
}

/** The tree's row label for an entry that cannot be opened. */
export function whyNotOpenable(entry: FileEntry): string | null {
  if (entry.kind === "other") return "not a file or directory here (a device, a socket, or a link out of the root)";
  return null;
}
