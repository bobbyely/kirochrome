import { test } from "node:test";
import assert from "node:assert/strict";
import { keyboardMarks, score } from "../games/wordle.ts";
import { canSpell, points, shuffle } from "../games/anagram.ts";

test("score: exact match is all hits", () => {
  assert.deepEqual(score("crane", "crane"), ["hit", "hit", "hit", "hit", "hit"]);
});

test("score: a repeated guess letter is near only while the answer has copies left", () => {
  // steel has two e's, so both leading e's of eerie are near and the third is not.
  assert.deepEqual(score("eerie", "steel"), ["near", "near", "miss", "miss", "miss"]);
  // Hits are claimed before nears: the e that lands is a hit, one more e is
  // near, and the last e is a miss even though it comes before the hit.
  assert.deepEqual(score("geese", "steel"), ["miss", "near", "hit", "near", "miss"]);
});

test("score: near does not double-count a letter already a hit", () => {
  assert.deepEqual(score("allow", "alley"), ["hit", "hit", "hit", "miss", "miss"]);
});

test("keyboardMarks keeps the best mark per letter", () => {
  const marks = keyboardMarks(["crane", "tacit"], "cabin");
  assert.equal(marks.get("c"), "hit");
  assert.equal(marks.get("a"), "hit");
  assert.equal(marks.get("t"), "miss");
  assert.equal(marks.get("i"), "hit");
  assert.equal(marks.get("r"), "miss");
});

test("canSpell respects letter counts", () => {
  assert.equal(canSpell("seen", "engines"), true);
  assert.equal(canSpell("sees", "engines"), false);
  assert.equal(canSpell("", "abc"), true);
});

test("shuffle keeps the multiset and never returns the input order", () => {
  for (let i = 0; i < 50; i++) {
    const out = shuffle("balance");
    assert.notEqual(out, "balance");
    assert.equal([...out].sort().join(""), "aabceln");
  }
});

test("points: longer is worth more, the puzzle word doubles", () => {
  assert.equal(points("seen", "engines"), 1);
  assert.equal(points("engine", "engines"), 3);
  assert.equal(points("engines", "engines"), 8);
});
