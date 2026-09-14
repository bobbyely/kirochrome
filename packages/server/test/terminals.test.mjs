import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let TerminalRegistry, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-terminals-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  ({ TerminalRegistry } = await import("../dist/terminals.js"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("outputByteLimit", () => {
  it("is refused when it is not a positive integer, rather than silently emptying the output", () => {
    // 0 and negatives used to leave the agent a blank buffer that read as a
    // command with no output — the value was wrong and nothing said so.
    const reg = new TerminalRegistry();
    for (const bad of [0, -1, 1.5, NaN]) {
      assert.throws(
        () => reg.create({ command: "true", args: [], outputByteLimit: bad }),
        (e) => /outputByteLimit/.test(String(e.message ?? e)),
        `expected ${bad} to be refused`,
      );
    }
    reg.releaseAll();
  });

  it("takes a positive value, and null means the default", async () => {
    const reg = new TerminalRegistry();
    const a = reg.create({ command: "sh", args: ["-c", "echo hello"], outputByteLimit: 3 });
    await reg.waitForExit(a.terminalId);
    assert.equal(reg.output(a.terminalId).output.length, 3);
    assert.equal(reg.output(a.terminalId).truncated, true);
    const b = reg.create({ command: "sh", args: ["-c", "echo hello"], outputByteLimit: null });
    await reg.waitForExit(b.terminalId);
    assert.equal(reg.output(b.terminalId).truncated, false);
    reg.releaseAll();
  });
});
