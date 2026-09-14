import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  causeOf,
  FILE_TEXT_LIMIT,
  KC_ERROR_CODES,
  kcError,
  type FileContent,
  type FileEntry,
  type FilesResponse,
  type KcError,
} from "@kirochrome/shared";

/**
 * The browser's view of a conversation's directories.
 *
 * A different trust boundary from `fs.ts`: that serves the agent, a local
 * process that can already read anything the user can, so it is unsandboxed.
 * This serves the browser, and any page the user has open can attempt a
 * request to localhost — the Origin check is one control, not a boundary. So
 * every path here is confined to one of the session's roots, checked on the
 * *real* path after symlinks are followed, or a chat UI becomes a
 * read-anything endpoint.
 */

/** Only these are served as themselves; everything else is text or "binary". SVG is XML with scripts in it, so it is text. */
const RAW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

/** Extensions the raw route serves, for the browser to pick a route without a round trip. */
export const RAW_EXTENSIONS = new Set(Object.keys(RAW_MIME));

/**
 * The real path of `path` under `root`, or a typed error. Both sides are
 * resolved through symlinks before comparing, so a link inside the root that
 * points out of it is refused as firmly as a `..`.
 */
export async function confine(roots: string[], root: string, path: string): Promise<string> {
  if (!roots.includes(root)) {
    throw kcError("FILE_INVALID", `${root} is not one of this conversation's directories.`);
  }
  if (path.includes("\0") || isAbsolute(path)) {
    throw kcError("FILE_INVALID", `Paths are relative to the directory; got '${path}'.`);
  }
  const base = await real(root);
  const target = await real(resolve(root, path));
  if (target !== base && !target.startsWith(base + sep)) {
    throw kcError("FILE_INVALID", `${path} is outside ${root}.`);
  }
  return target;
}

export async function listDirectory(roots: string[], root: string, path: string): Promise<FilesResponse> {
  const dir = await confine(roots, root, path);
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw notFound(path || root, err);
  }

  const ignored = await ignoredIn(dir, names.map((d) => d.name));
  const entries: FileEntry[] = [];
  for (const dirent of names) {
    // A symlink is what it points at, as far as the reader is concerned; one
    // that points nowhere, or out of the root, is "other" and not followed.
    let kind: FileEntry["kind"] = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
    let size = 0;
    if (dirent.isSymbolicLink()) {
      try {
        const s = await stat(join(dir, dirent.name));
        const inside = (await real(join(dir, dirent.name))).startsWith(await real(root) + sep);
        kind = !inside ? "other" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
        size = kind === "file" ? s.size : 0;
      } catch {
        kind = "other";
      }
    } else if (kind === "file") {
      try {
        size = (await stat(join(dir, dirent.name))).size;
      } catch {
        kind = "other";
      }
    }
    entries.push({ name: dirent.name, kind, size, ignored: ignored.has(dirent.name) || dirent.name === ".git" });
  }

  // Directories first, then files, the ignored ones after the rest of their
  // kind — out of the way without being out of reach.
  const order = { dir: 0, file: 1, other: 2 };
  entries.sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      Number(a.ignored) - Number(b.ignored) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return { root, path, entries };
}

/**
 * A file as text, or the reason it is not being sent. Binary is decided the
 * way `git` decides it — a NUL in the first 8KB — so an unknown extension
 * still gets the right treatment.
 */
export async function readText(roots: string[], root: string, path: string): Promise<FileContent> {
  const file = await confine(roots, root, path);
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    throw notFound(path, err);
  }
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 8192));
    await handle.read(head, 0, head.length, 0);
    if (head.includes(0)) return { kind: "binary", size };
    if (size > FILE_TEXT_LIMIT) return { kind: "large", size };
    const content = Buffer.alloc(size);
    await handle.read(content, 0, size, 0);
    return { kind: "text", content: content.toString("utf8"), size };
  } finally {
    await handle.close();
  }
}

/** The path and content type for the raw route, which serves only what `RAW_MIME` names. */
export async function rawFile(roots: string[], root: string, path: string): Promise<{ file: string; mime: string }> {
  const file = await confine(roots, root, path);
  const mime = RAW_MIME[extname(path).toLowerCase()];
  if (!mime) throw kcError("FILE_INVALID", `${path} is not an image or a PDF; read it as text.`);
  let isFile = false;
  try {
    isFile = (await stat(file)).isFile();
  } catch (err) {
    throw notFound(path, err);
  }
  if (!isFile) throw notFound(path, null);
  return { file, mime };
}

/** A directory the user wants to add: absolute, real, and actually a directory. Returns it as given. */
export async function validateRoot(path: unknown): Promise<string> {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed || !isAbsolute(trimmed)) throw kcError("FILE_INVALID", "A directory must be an absolute path.");
  try {
    if (!(await stat(trimmed)).isDirectory()) throw kcError("FILE_INVALID", `${trimmed} is not a directory.`);
  } catch (err) {
    if (isOurs(err)) throw err;
    throw kcError("FILE_UNKNOWN", `${trimmed} does not exist.`, { cause: causeOf(err) });
  }
  return trimmed;
}

/**
 * Which of `names` git would ignore in `dir`. Nothing when `dir` is not in
 * a repository, or git is not installed: the pane shows everything as-is.
 * `check-ignore` exits 1 for "none ignored", so only its output matters.
 */
async function ignoredIn(dir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  return new Promise((resolveIgnored) => {
    const child = execFile(
      "git",
      ["-C", dir, "check-ignore", "--stdin", "-z", "--no-index"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 5_000 },
      (_err, stdout) => resolveIgnored(new Set(String(stdout).split("\0").filter(Boolean))),
    );
    child.stdin?.on("error", () => {
      /* git exited first (not a repo): the callback above still fires */
    });
    child.stdin?.end(names.join("\0") + "\0");
  });
}

async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    throw notFound(path, err);
  }
}

const notFound = (path: string, err: unknown): KcError =>
  isOurs(err) ? err : kcError("FILE_UNKNOWN", `${path} could not be read.`, { cause: err === null ? undefined : causeOf(err) });

/**
 * Not the shared `isKcError`: a Node `ENOENT` also has a `code` and a
 * `message`, and this module catches more of those than anything else does.
 */
const isOurs = (err: unknown): err is KcError =>
  typeof err === "object" && err !== null && "code" in err && (KC_ERROR_CODES as readonly unknown[]).includes(err.code);
