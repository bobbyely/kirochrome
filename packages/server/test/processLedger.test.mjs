import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let recordProcess, reapOrphans, dir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-ledger-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  ({ recordProcess, reapOrphans } = await import("../dist/processLedger.js"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("orphan reaping", () => {
  it("kills a recorded process group left behind by a crashed server", async () => {
    const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    child.unref();
    await sleep(150);
    recordProcess(child.pid, "sh -c sleep 30");
    assert.ok(alive(child.pid), "the child should be running before reaping");

    reapOrphans();
    await sleep(250);
    assert.ok(!alive(child.pid), "reaping must kill the recorded process");
  });

  it("leaves a process alone when the command no longer matches", async () => {
    // PIDs are recycled, so a stale entry could name something unrelated.
    const bystander = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    bystander.unref();
    await sleep(150);
    recordProcess(bystander.pid, "something /completely/different");

    reapOrphans();
    await sleep(250);
    assert.ok(alive(bystander.pid), "an unrelated process must not be killed");

    try { process.kill(-bystander.pid, "SIGKILL"); } catch { /* cleanup */ }
  });

  it("does nothing when there is no ledger", () => {
    assert.doesNotThrow(() => reapOrphans());
  });
});
