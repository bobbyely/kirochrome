import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseContext, countChanges, lineDiff } from "../diff.ts";

describe("lineDiff", () => {
  it("marks a single changed line without touching its neighbours", () => {
    const lines = lineDiff("a\nb\nc", "a\nB\nc");
    assert.deepEqual(
      lines?.map((l) => `${l.kind}:${l.text}`),
      ["ctx:a", "del:b", "add:B", "ctx:c"],
    );
  });

  it("treats an empty side as no lines, not one blank line", () => {
    // "".split("\n") is [""], which would render a phantom deleted blank line.
    assert.deepEqual(countChanges(lineDiff("", "x\ny")!), { added: 2, removed: 0 });
    assert.deepEqual(countChanges(lineDiff("x\ny", "")!), { added: 0, removed: 2 });
  });

  it("reports no changes for identical text", () => {
    assert.deepEqual(countChanges(lineDiff("same\nlines", "same\nlines")!), { added: 0, removed: 0 });
  });

  it("refuses inputs too large for the quadratic table", () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n");
    assert.equal(lineDiff(huge, `${huge}\nx`), null);
  });
});

describe("collapseContext", () => {
  it("collapses long unchanged runs but keeps context around each change", () => {
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const rows = collapseContext(lineDiff(big, big.replace("line 30", "line 30!"))!, 2);
    assert.ok(rows.length < 15, `expected a collapsed view, got ${rows.length} rows`);
    assert.ok(rows.some((r) => r.kind === "gap"), "expected a gap marker");
    assert.ok(rows.some((r) => r.kind === "add"), "expected the change itself");
  });
});
