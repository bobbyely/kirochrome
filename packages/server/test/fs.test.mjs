import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let readTextFile, writeTextFile, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-fs-"));
  ({ readTextFile, writeTextFile } = await import("../dist/fs.js"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("fs/read_text_file", () => {
  it("reads a whole file", async () => {
    const path = join(dir, "a.txt");
    writeFileSync(path, "one\ntwo\nthree");
    assert.equal((await readTextFile({ path })).content, "one\ntwo\nthree");
  });

  it("slices from a 1-based line, with an optional limit", async () => {
    const path = join(dir, "b.txt");
    writeFileSync(path, "1\n2\n3\n4\n5");
    assert.equal((await readTextFile({ path, line: 2 })).content, "2\n3\n4\n5");
    assert.equal((await readTextFile({ path, line: 2, limit: 2 })).content, "2\n3");
    assert.equal((await readTextFile({ path, limit: 2 })).content, "1\n2");
  });

  it("rejects a relative path rather than resolving it against something arbitrary", async () => {
    await assert.rejects(() => readTextFile({ path: "relative.txt" }), /absolute/);
  });

  it("reports a missing file as an error, not empty content", async () => {
    await assert.rejects(() => readTextFile({ path: join(dir, "nope.txt") }));
  });
});

describe("fs/write_text_file", () => {
  it("writes a file", async () => {
    const path = join(dir, "out.txt");
    await writeTextFile({ path, content: "hello" });
    assert.equal(readFileSync(path, "utf8"), "hello");
  });

  it("creates missing directories, since agents write into new trees", async () => {
    const path = join(dir, "deep", "nested", "new.txt");
    await writeTextFile({ path, content: "x" });
    assert.equal(readFileSync(path, "utf8"), "x");
  });

  it("rejects a relative path", async () => {
    await assert.rejects(() => writeTextFile({ path: "rel.txt", content: "x" }), /absolute/);
  });
});
