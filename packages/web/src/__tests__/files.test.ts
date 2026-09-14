import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSize, parseDelimited, prettyJson, viewerFor } from "../files.ts";

describe("viewerFor", () => {
  it("picks by extension, case-insensitively, and defaults to code", () => {
    assert.equal(viewerFor("logo.PNG"), "image");
    assert.equal(viewerFor("paper.pdf"), "pdf");
    assert.equal(viewerFor("README.md"), "markdown");
    assert.equal(viewerFor("data.csv"), "table");
    assert.equal(viewerFor("data.tsv"), "table");
    assert.equal(viewerFor("package.json"), "json");
    assert.equal(viewerFor("main.rs"), "code");
    assert.equal(viewerFor("Makefile"), "code");
    assert.equal(viewerFor(".gitignore"), "code", "a dotfile has no extension");
  });
});

describe("parseDelimited", () => {
  it("handles quoted delimiters, newlines and doubled quotes", () => {
    const { rows, total } = parseDelimited('a,b\n"x, y","say ""hi""\nthere"\r\n1,2\n', ",");
    assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"\nthere'], ["1", "2"]]);
    assert.equal(total, 3);
  });

  it("reads tabs, and counts rows beyond the limit without keeping them", () => {
    assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t").rows, [["a", "b"], ["1", "2"]]);
    const big = Array.from({ length: 600 }, (_, i) => `${i},x`).join("\n");
    const { rows, total } = parseDelimited(big, ",");
    assert.equal(rows.length, 500);
    assert.equal(total, 600);
  });
});

describe("prettyJson and formatSize", () => {
  it("pretty-prints valid JSON and returns null for the rest", () => {
    assert.equal(prettyJson('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}');
    assert.equal(prettyJson("{not json"), null);
  });
  it("formats sizes in the unit a person would use", () => {
    assert.equal(formatSize(12), "12 B");
    assert.equal(formatSize(348160), "340 KB");
    assert.equal(formatSize(1258291), "1.2 MB");
  });
});
