import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeMention, mentionAt, mentionPath, mentionedIn, splitMention } from "../mentions.ts";

const entries = [
  { name: "src", kind: "dir" as const, size: 0, ignored: false },
  { name: "README.md", kind: "file" as const, size: 8, ignored: false },
  { name: "sock", kind: "other" as const, size: 0, ignored: false },
];

describe("mentionAt", () => {
  it("finds a mention only at the end, after a space or the start", () => {
    assert.deepEqual(mentionAt("look at @src/a"), { typed: "src/a", at: 8 });
    assert.deepEqual(mentionAt("@"), { typed: "", at: 0 });
    assert.equal(mentionAt("mail me@example.com"), null);
    assert.equal(mentionAt("@src/a.ts done"), null, "the caret has moved on");
  });
});

describe("completeMention", () => {
  it("lists the directory's entries by prefix, directories staying open, files closing", () => {
    const out = completeMention("see @", { typed: "", at: 4 }, entries, []);
    assert.deepEqual(out.map((c) => [c.label, c.replacement]), [
      ["src/", "see @src/"],
      ["README.md", "see @README.md "],
    ]);
    assert.deepEqual(completeMention("see @re", { typed: "re", at: 4 }, entries, []).map((c) => c.label), ["README.md"]);
  });

  it("offers other roots at the top level, completing to their absolute path", () => {
    const out = completeMention("@r", { typed: "r", at: 0 }, entries, ["/home/me/reference"]);
    assert.deepEqual(out.map((c) => [c.label, c.replacement]), [
      ["README.md", "@README.md "],
      ["reference/", "@/home/me/reference/"],
    ]);
    assert.equal(completeMention("@src/r", { typed: "src/r", at: 0 }, [], ["/home/me/reference"]).length, 0, "not below the top");
  });

  it("splits a partial into its directory and prefix", () => {
    assert.deepEqual(splitMention("src/comp/Bu"), { dir: "src/comp/", prefix: "Bu", absolute: false });
    assert.deepEqual(splitMention("/abs/x"), { dir: "/abs/", prefix: "x", absolute: true });
  });
});

describe("what is sent", () => {
  it("records a chosen file and keeps only chosen mentions still in the text", () => {
    assert.equal(mentionPath("see @src/a.ts "), "src/a.ts");
    assert.equal(mentionPath("see @src/"), null, "a directory is not finished");
    const chosen = new Set(["src/a.ts", "/abs/b.md"]);
    assert.deepEqual(mentionedIn("fix @src/a.ts and @/abs/b.md, not @typed or me@x.y", chosen), ["src/a.ts", "/abs/b.md"]);
    assert.deepEqual(mentionedIn("nothing here", chosen), []);
  });
});
