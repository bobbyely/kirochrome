import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // Deliberately not `sh -c "sleep 30"`: bash exec-replaces itself there, so
    // its command line changes and the test would pass on Linux (dash) and fail
    // on macOS. Identity is the start time, but the process still has to be one
    // whose behaviour is the same everywhere.
    const child = spawn("sh", ["-c", "sleep 30 && echo done"], { detached: true, stdio: "ignore" });
    child.unref();
    await sleep(200);
    recordProcess(child.pid, "sh -c sleep 30");
    assert.ok(alive(child.pid), "the child should be running before reaping");

    reapOrphans();
    await sleep(300);
    assert.ok(!alive(child.pid), "reaping must kill the recorded process");
  });

  it("still reaps a process whose shell exec-replaced itself", async () => {
    // bash optimises `sh -c "<single command>"` into an exec, so the live
    // command line no longer matches what was recorded. Matching on command
    // text used to miss these entirely.
    const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    child.unref();
    await sleep(200);
    recordProcess(child.pid, "sh -c sleep 30");

    reapOrphans();
    await sleep(300);
    assert.ok(!alive(child.pid), "an exec must not hide an orphan from reaping");
  });

  it("leaves a process alone when the command no longer matches", async () => {
    // PIDs are recycled, so a stale entry could name something unrelated.
    const bystander = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    bystander.unref();
    await sleep(150);
    // Simulate a stale entry: a PID the OS has since handed to something else.
    // A fabricated start time stands in for "this is not the process we
    // recorded".
    recordProcess(bystander.pid, "irrelevant");
    const ledger = join(dir, "processes.tsv");
    writeFileSync(ledger, `${bystander.pid}\tThu Jan  1 00:00:00 1970\tirrelevant\n`);

    reapOrphans();
    await sleep(250);
    assert.ok(alive(bystander.pid), "an unrelated process must not be killed");

    try { process.kill(-bystander.pid, "SIGKILL"); } catch { /* cleanup */ }
  });

  it("does nothing when there is no ledger", () => {
    assert.doesNotThrow(() => reapOrphans());
  });
});
