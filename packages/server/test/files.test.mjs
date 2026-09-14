// The Files pane's server side. This is a browser-facing endpoint over the
// user's disk, so most of these are about what it refuses: the trust boundary
// is the point, and the listing is the easy part.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let confine, listDirectory, readText, rawFile, validateRoot, resolveMention, collectRoots;
let base, project, elsewhere, roots;

before(async () => {
  ({ confine, listDirectory, readText, rawFile, validateRoot, resolveMention } = await import("../dist/files.js"));
  ({ collectRoots } = await import("@kirochrome/shared"));
  // realpath: on macOS /tmp is a symlink, and confinement compares real paths.
  base = realpathSync(mkdtempSync(join(tmpdir(), "kc-files-")));
  project = join(base, "project");
  elsewhere = join(base, "elsewhere");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "node_modules", "dep"), { recursive: true });
  mkdirSync(elsewhere);
  writeFileSync(join(project, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(project, "README.md"), "# Hello\n");
  writeFileSync(join(project, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(join(project, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(project, ".gitignore"), "node_modules/\n*.log\n");
  writeFileSync(join(project, "debug.log"), "noise\n");
  writeFileSync(join(elsewhere, "secret.txt"), "not yours\n");
  symlinkSync(elsewhere, join(project, "escape"));
  symlinkSync(join(elsewhere, "secret.txt"), join(project, "escape.txt"));
  execFileSync("git", ["-C", project, "init", "-q"]);
  roots = [project];
});
after(() => rmSync(base, { recursive: true, force: true }));

const code = (p) => p.then(() => null, (e) => e.code);

describe("confinement", () => {
  it("refuses a root that is not the conversation's, a .., an absolute path, and a NUL", async () => {
    assert.equal(await code(confine(roots, elsewhere, "")), "FILE_INVALID");
    assert.equal(await code(confine(roots, project, "../elsewhere/secret.txt")), "FILE_INVALID");
    assert.equal(await code(confine(roots, project, "/etc/passwd")), "FILE_INVALID");
    assert.equal(await code(confine(roots, project, "src\0/index.ts")), "FILE_INVALID");
  });

  it("follows symlinks before deciding, so a link out of the root is refused", async () => {
    assert.equal(await code(confine(roots, project, "escape/secret.txt")), "FILE_INVALID");
    assert.equal(await code(confine(roots, project, "escape.txt")), "FILE_INVALID");
    assert.equal(await code(readText(roots, project, "escape.txt")), "FILE_INVALID");
  });

  it("allows the root itself and what is inside it; a missing file is FILE_UNKNOWN", async () => {
    assert.equal(await confine(roots, project, ""), project);
    assert.equal(await confine(roots, project, "src/index.ts"), join(project, "src", "index.ts"));
    assert.equal(await code(confine(roots, project, "src/nope.ts")), "FILE_UNKNOWN");
  });

  it("a second root is browsable once it is in the list, and not before", async () => {
    assert.equal(await code(readText(roots, elsewhere, "secret.txt")), "FILE_INVALID");
    const both = collectRoots(project, [{ seq: 1, ts: 0, type: "root_added", path: elsewhere }]);
    assert.deepEqual(both, [project, elsewhere]);
    assert.equal((await readText(both, elsewhere, "secret.txt")).content, "not yours\n");
  });
});

describe("listing", () => {
  it("lists a directory with kinds and sizes, directories first, ignored last", async () => {
    const { entries } = await listDirectory(roots, project, "");
    const names = entries.map((e) => `${e.kind}:${e.name}${e.ignored ? "~" : ""}`);
    assert.deepEqual(names, [
      "dir:src",
      "dir:.git~",
      "dir:node_modules~",
      "file:.gitignore",
      "file:blob.bin",
      "file:logo.png",
      "file:README.md",
      "file:debug.log~",
      "other:escape",
      "other:escape.txt",
    ]);
    assert.equal(entries.find((e) => e.name === "README.md").size, 8);
  });

  it("marks nothing ignored outside a repository", async () => {
    const { entries } = await listDirectory([elsewhere], elsewhere, "");
    assert.deepEqual(entries.map((e) => e.ignored), [false]);
  });

  it("lists a subdirectory by relative path", async () => {
    const { path, entries } = await listDirectory(roots, project, "src");
    assert.equal(path, "src");
    assert.deepEqual(entries.map((e) => e.name), ["index.ts"]);
  });
});

describe("reading", () => {
  it("returns text, calls a NUL binary, and refuses to send a large file", async () => {
    assert.deepEqual(await readText(roots, project, "src/index.ts"), { kind: "text", content: "export const x = 1;\n", size: 20 });
    assert.deepEqual(await readText(roots, project, "blob.bin"), { kind: "binary", size: 4 });
    writeFileSync(join(project, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    assert.equal((await readText(roots, project, "big.txt")).kind, "large");
  });

  it("serves only images and PDFs raw, by extension", async () => {
    const { mime } = await rawFile(roots, project, "logo.png");
    assert.equal(mime, "image/png");
    assert.equal(await code(rawFile(roots, project, "README.md")), "FILE_INVALID");
    assert.equal(await code(rawFile(roots, project, "src")), "FILE_INVALID", "no extension, so not raw");
    assert.equal(await code(rawFile(roots, project, "missing.png")), "FILE_UNKNOWN");
  });
});

describe("adding a root", () => {
  it("wants an absolute path to an existing directory", async () => {
    assert.equal(await code(validateRoot("relative/path")), "FILE_INVALID");
    assert.equal(await code(validateRoot(join(base, "missing"))), "FILE_UNKNOWN");
    assert.equal(await code(validateRoot(join(project, "README.md"))), "FILE_INVALID");
    assert.equal(await validateRoot(`  ${elsewhere}  `), elsewhere);
  });

  it("replays the log: added once, removable, the cwd always first", () => {
    const ev = (type, path, seq) => ({ seq, ts: 0, type, path });
    assert.deepEqual(collectRoots("/p", []), ["/p"]);
    assert.deepEqual(collectRoots("/p", [ev("root_added", "/a", 1), ev("root_added", "/a", 2), ev("root_added", "/p", 3)]), ["/p", "/a"]);
    assert.deepEqual(collectRoots("/p", [ev("root_added", "/a", 1), ev("root_removed", "/a", 2), ev("root_removed", "/b", 3)]), ["/p"]);
  });
});

describe("an @ mention", () => {
  it("resolves relative to the cwd, or absolute inside any root, and refuses the rest", async () => {
    const both = [project, elsewhere];
    assert.deepEqual(await resolveMention(both, project, "src/index.ts"), { path: join(project, "src", "index.ts"), name: "index.ts", size: 20 });
    assert.equal((await resolveMention(both, project, `${elsewhere}/secret.txt`)).name, "secret.txt", "absolute, in the other root");
    assert.equal(await code(resolveMention([project], project, `${elsewhere}/secret.txt`)), "FILE_INVALID", "absolute, outside every root");
    assert.equal(await code(resolveMention(both, project, "escape.txt")), "FILE_INVALID", "a link out");
    assert.equal(await code(resolveMention(both, project, "src")), "FILE_INVALID", "a directory");
    assert.equal(await code(resolveMention(both, project, "nope.ts")), "FILE_UNKNOWN");
    assert.equal(await code(resolveMention(both, project, "  ")), "FILE_INVALID");
  });
});
