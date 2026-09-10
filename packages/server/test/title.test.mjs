import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { titleFromMessage } from "../dist/title.js";

describe("titleFromMessage", () => {
  it("keeps a short message as it is", () => {
    assert.equal(titleFromMessage("Add a dark theme"), "Add a dark theme");
  });

  it("takes the first line, not the first 60 characters", () => {
    const text = "Fix the export button\n\nIt writes the file but the download never starts.";
    assert.equal(titleFromMessage(text), "Fix the export button");
  });

  it("drops a leading pleasantry", () => {
    assert.equal(titleFromMessage("can you please add a dark theme"), "Add a dark theme");
    assert.equal(titleFromMessage("hey, fix the export button"), "Fix the export button");
    assert.equal(titleFromMessage("I want you to rename the sidebar"), "Rename the sidebar");
  });

  it("keeps 'please' when it is not the opener", () => {
    assert.equal(titleFromMessage("Rename it, please"), "Rename it, please");
  });

  it("never strips filler down to nothing", () => {
    assert.equal(titleFromMessage("help me"), "Help me");
  });

  it("strips markdown scaffolding", () => {
    assert.equal(titleFromMessage("## Fix the parser"), "Fix the parser");
    assert.equal(titleFromMessage("- fix the `parser`"), "Fix the parser");
    assert.equal(titleFromMessage("> quoted request"), "Quoted request");
    assert.equal(titleFromMessage("1. First job"), "First job");
  });

  it("skips a leading code fence and uses the prose after it", () => {
    const text = "```\nnpm test\n```\nWhy does this fail?";
    assert.equal(titleFromMessage(text), "Why does this fail?");
  });

  it("truncates a long line with an ellipsis", () => {
    const title = titleFromMessage("a".repeat(200));
    assert.equal(title.length, 60);
    assert.ok(title.endsWith("…"));
  });

  it("collapses runs of whitespace", () => {
    assert.equal(titleFromMessage("fix    the     parser"), "Fix the parser");
  });

  it("returns null when there is nothing usable", () => {
    assert.equal(titleFromMessage(""), null);
    assert.equal(titleFromMessage("   \n\n  "), null);
    assert.equal(titleFromMessage("```\nnpm test\n```"), null);
  });
});
