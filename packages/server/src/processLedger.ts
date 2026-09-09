import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.js";

/**
 * A record of every process we spawn, so a server that dies without cleaning up
 * does not leak them forever.
 *
 * Agents are spawned detached (their own process group, so we can kill the
 * whole tree), which also means they survive their parent. A well-behaved ACP
 * agent exits when its stdin closes — but anything *it* started in the
 * background does not, and neither does an agent that ignores EOF.
 *
 * Reaping runs ONCE at server startup. It must never run per-session: that
 * would kill processes belonging to sessions that are still alive.
 */
const ledgerPath = () => join(dataDir(), "processes.tsv");

export function recordProcess(pid: number, command: string): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    // The start time is the identity check. Command text is recorded only for
    // the log: a shell may exec-replace itself (`sh -c "sleep 30"` becomes
    // `sleep 30` under bash but not dash), so it is not reliable for matching.
    const started = startTime(pid) ?? "";
    appendFileSync(ledgerPath(), `${pid}\t${started}\t${command.replace(/\s+/g, " ")}\n`);
  } catch {
    // Leak protection is best-effort; never fail a spawn over bookkeeping.
  }
}

/** The process's start time, as the OS reports it. Stable across an exec. */
function startTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Kills process groups left behind by a previous server.
 *
 * PIDs are recycled by the OS, so killing one blindly could hit an unrelated
 * process. Every entry is verified against the live process's command line
 * first, and skipped when it does not match.
 */
export function reapOrphans(): void {
  let entries: Array<{ pid: number; started: string; command: string }>;
  try {
    entries = readFileSync(ledgerPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid = "", started = "", ...rest] = line.split("\t");
        return { pid: Number(pid), started, command: rest.join("\t") };
      })
      .filter((e) => Number.isInteger(e.pid) && e.pid > 0);
  } catch {
    return;
  }

  let reaped = 0;
  for (const entry of entries) {
    if (!stillOurs(entry.pid, entry.started)) continue;
    try {
      process.kill(-entry.pid, "SIGKILL"); // the group, not just the leader
      reaped++;
    } catch {
      try {
        process.kill(entry.pid, "SIGKILL"); // not a group leader; kill it alone
        reaped++;
      } catch {
        // Already gone.
      }
    }
  }

  if (reaped > 0) console.log(`[processes] reaped ${reaped} orphan(s) from a previous run`);
  try {
    writeFileSync(ledgerPath(), "");
  } catch {
    /* best effort */
  }
}

/**
 * Guards against PID reuse: only kill if this is still the same process.
 *
 * Compared on start time rather than command line. A recycled PID gets a new
 * start time, while an exec keeps it — so this neither kills a stranger nor
 * misses an orphan whose shell replaced itself.
 *
 * With no recorded start time we decline: failing to reap leaks a process,
 * whereas a wrong kill takes down something that is not ours.
 */
function stillOurs(pid: number, started: string): boolean {
  if (!started) return false;
  return startTime(pid) === started;
}
