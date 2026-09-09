import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlashCommand } from "@kirochrome/shared";
import { commonPrefix, complete } from "../commands.ts";

// Shaped like what Kiro advertises.
const commands: SlashCommand[] = [
  { name: "effort", description: "Set reasoning effort", input: { hint: "low|medium|high|xhigh|max" } },
  { name: "editor", description: "Open an editor" },
  { name: "compact", description: "Compact the conversation" },
  { name: "web", description: "Search the web", input: { hint: "query to search for" } },
];

describe("command completion", () => {
  it("offers everything on a bare slash", () => {
    assert.equal(complete("/", commands).length, 4);
  });

  it("filters by prefix as you type", () => {
    assert.deepEqual(complete("/e", commands).map((m) => m.label), ["/effort", "/editor"]);
    assert.deepEqual(complete("/comp", commands).map((m) => m.label), ["/compact"]);
    assert.deepEqual(complete("/zzz", commands), []);
  });

  it("leaves a trailing space only when the command takes an argument", () => {
    assert.equal(complete("/effort", commands)[0]!.replacement, "/effort ");
    assert.equal(complete("/compact", commands)[0]!.replacement, "/compact");
  });

  it("offers nothing for ordinary prose", () => {
    assert.deepEqual(complete("hello", commands), []);
    assert.deepEqual(complete("what about /effort", commands), []);
  });
});

describe("argument completion", () => {
  it("completes values a hint enumerates", () => {
    assert.deepEqual(
      complete("/effort ", commands).map((m) => m.label),
      ["low", "medium", "high", "xhigh", "max"],
    );
    assert.deepEqual(complete("/effort h", commands).map((m) => m.label), ["high"]);
    assert.equal(complete("/effort h", commands)[0]!.replacement, "/effort high");
  });

  it("does not invent values from a prose hint", () => {
    // "query to search for" is a description, not a choice list.
    assert.deepEqual(complete("/web ", commands), []);
  });

  it("offers nothing for a command with no argument", () => {
    assert.deepEqual(complete("/compact ", commands), []);
  });
});

describe("commonPrefix", () => {
  it("finds the longest shared prefix, as a shell would", () => {
    assert.equal(commonPrefix(["/effort ", "/editor"]), "/e");
    assert.equal(commonPrefix(["/compact"]), "/compact");
    assert.equal(commonPrefix(["/effort", "/compact"]), "/");
    assert.equal(commonPrefix([]), "");
  });
});
