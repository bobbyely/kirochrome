import type { FileEntry } from "@kirochrome/shared";
import type { Completion } from "./commands.js";

/**
 * `@` mentions in the composer: the pure part. Where the mention being typed
 * is, what directory it is completing in, and which chosen mentions are still
 * in the text when it is sent. No fetching — the composer does that.
 */

export interface MentionAt {
  /** The text after `@`, as typed so far. */
  typed: string;
  /** Index of the `@` in the draft. */
  at: number;
}

/** The mention under the caret — the draft must end in one. `me@example.com` is not one. */
export function mentionAt(draft: string): MentionAt | null {
  const m = /(?:^|\s)@(\S*)$/.exec(draft);
  if (!m) return null;
  return { typed: m[1] ?? "", at: draft.length - (m[1]?.length ?? 0) - 1 };
}

/** Which directory a partial mention is listing, and the name prefix inside it. */
export function splitMention(typed: string): { dir: string; prefix: string; absolute: boolean } {
  const slash = typed.lastIndexOf("/");
  const absolute = typed.startsWith("/");
  if (slash < 0) return { dir: "", prefix: typed, absolute };
  return { dir: typed.slice(0, slash + 1), prefix: typed.slice(slash + 1), absolute };
}

/**
 * Completions for a partial mention from the directory it names. Directories
 * complete to `dir/` and keep the picker open; files complete and close it.
 * At the top level the other roots are offered too, by name, and complete to
 * their absolute path — a relative mention always means the working directory.
 */
export function completeMention(
  draft: string,
  mention: MentionAt,
  entries: FileEntry[] | undefined,
  otherRoots: string[],
): Completion[] {
  const { dir, prefix } = splitMention(mention.typed);
  const head = draft.slice(0, mention.at + 1);
  const out: Completion[] = [];
  const lower = prefix.toLowerCase();

  for (const entry of entries ?? []) {
    if (entry.kind === "other") continue;
    if (!entry.name.toLowerCase().startsWith(lower)) continue;
    const path = `${dir}${entry.name}`;
    out.push(
      entry.kind === "dir"
        ? { label: `${entry.name}/`, detail: dir || "directory", replacement: `${head}${path}/` }
        : { label: entry.name, detail: dir || "file", replacement: `${head}${path} ` },
    );
  }
  if (dir === "" && !mention.typed.startsWith("/")) {
    for (const root of otherRoots) {
      const name = root.replace(/\/+$/, "").split("/").pop() ?? root;
      if (!name.toLowerCase().startsWith(lower)) continue;
      out.push({ label: `${name}/`, detail: root, hint: "added directory", replacement: `${head}${root}/` });
    }
  }
  return out;
}

/** The path a completed mention names, if the draft ends in a finished one — what `choose` records. */
export function mentionPath(replacement: string): string | null {
  const m = /(?:^|\s)@(\S+) $/.exec(replacement);
  return m ? (m[1] ?? null) : null;
}

/**
 * Of the mentions chosen from the picker, those still in the text being sent.
 * Only chosen ones count — a hand-typed `@thing` is prose, so a stray `@`
 * never turns a message into a failed attachment.
 */
export function mentionedIn(text: string, chosen: ReadonlySet<string>): string[] {
  const present = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const raw = m[1] ?? "";
    // "@a.ts," — the comma is prose, unless a file really is called that.
    const path = chosen.has(raw) ? raw : raw.replace(/[,.;:!?)\]]+$/, "");
    if (chosen.has(path)) present.add(path);
  }
  return [...present];
}
