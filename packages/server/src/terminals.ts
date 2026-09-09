import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { killTree } from "./agentProcess.js";
import { dataDir } from "./paths.js";

/** Backstop cap. Agents implement their own timeouts; this catches the ones that do not. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 1_000_000;

interface Terminal {
  id: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  limit: number;
  exit: { exitCode: number | null; signal: string | null } | null;
  timedOut: boolean;
  waiters: Array<(exit: { exitCode: number | null; signal: string | null }) => void>;
  timer: NodeJS.Timeout;
}

/**
 * Commands the agent asked us to run.
 *
 * Because we advertise `terminal: true`, the agent delegates execution to us —
 * so the lifetime of every one of these processes is our responsibility. Three
 * hazards are handled here: a command that never exits, one that produces
 * unbounded output, and a kill that leaves orphaned grandchildren behind.
 */
export class TerminalRegistry {
  private readonly terminals = new Map<string, Terminal>();
  private readonly pidFile = join(dataDir(), "terminals.pid");

  constructor() {
    mkdirSync(dataDir(), { recursive: true });
    this.reapOrphans();
  }

  // Nullable fields mirror the ACP schema, which uses null rather than omission.
  create(params: {
    command: string;
    args?: string[] | null;
    cwd?: string | null;
    env?: Array<{ name: string; value: string }> | null;
    outputByteLimit?: number | null;
  }): { terminalId: string } {
    const id = randomUUID();
    const env = { ...process.env };
    for (const entry of params.env ?? []) env[entry.name] = entry.value;

    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so kill() can take down the whole tree. Killing only
      // the direct child leaves grandchildren holding the pipes open, which is
      // what a "hung" command usually actually is.
      detached: process.platform !== "win32",
    });

    const terminal: Terminal = {
      id,
      child,
      output: "",
      truncated: false,
      limit: params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
      exit: null,
      timedOut: false,
      waiters: [],
      timer: setTimeout(() => {
        terminal.timedOut = true;
        killTree(child);
      }, DEFAULT_TIMEOUT_MS),
    };
    terminal.timer.unref();

    const collect = (chunk: string) => this.appendOutput(terminal, chunk);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const settle = (exit: { exitCode: number | null; signal: string | null }) => {
      if (terminal.exit) return;
      clearTimeout(terminal.timer);
      terminal.exit = exit;
      for (const resolve of terminal.waiters) resolve(exit);
      terminal.waiters.length = 0;
    };

    child.once("exit", (code, signal) => settle({ exitCode: code, signal: signal ?? null }));

    // A command that cannot start emits 'error', not 'exit'. Without this the
    // unhandled event takes down the whole server — and the agent chooses these
    // commands, so a typo in a tool call must not be fatal.
    child.once("error", (err: NodeJS.ErrnoException) => {
      this.appendOutput(terminal, `[kirochrome] could not start '${params.command}': ${err.message}\n`);
      settle({ exitCode: 127, signal: null }); // 127 is the shell's "command not found"
    });

    if (child.pid !== undefined) this.recordPid(child.pid);
    this.terminals.set(id, terminal);
    return { terminalId: id };
  }

  output(id: string): { output: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null } {
    const terminal = this.require(id);
    const note = terminal.timedOut ? "\n[kirochrome] killed: exceeded the time limit\n" : "";
    return {
      output: terminal.output + note,
      truncated: terminal.truncated,
      exitStatus: terminal.exit,
    };
  }

  async waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const terminal = this.require(id);
    if (terminal.exit) return terminal.exit;
    return new Promise((resolve) => terminal.waiters.push(resolve));
  }

  /** Kills the command; the terminal stays valid so its exit status can still be read. */
  kill(id: string): void {
    killTree(this.require(id).child);
  }

  /** Kills anything still running and forgets the terminal entirely. */
  release(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    clearTimeout(terminal.timer);
    killTree(terminal.child);
    this.terminals.delete(id);
  }

  releaseAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id);
  }

  private appendOutput(terminal: Terminal, chunk: string): void {
    terminal.output += chunk;
    if (terminal.output.length <= terminal.limit) return;
    // Truncate from the start, at a character boundary, per the ACP spec.
    terminal.output = terminal.output.slice(terminal.output.length - terminal.limit);
    terminal.truncated = true;
  }

  private require(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`Unknown terminal '${id}'.`);
    return terminal;
  }

  private recordPid(pid: number): void {
    try {
      appendFileSync(this.pidFile, `${pid}\n`);
    } catch {
      // Orphan reaping is best-effort; never fail a command over it.
    }
  }

  /**
   * Kills processes left behind by a server that died without cleaning up.
   * Without this, a crash leaks every running command until the machine reboots.
   */
  private reapOrphans(): void {
    let pids: number[];
    try {
      pids = readFileSync(this.pidFile, "utf8")
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return;
    }

    let reaped = 0;
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL"); // the group, not just the leader
        reaped++;
      } catch {
        // Already gone, or not ours any more.
      }
    }
    if (reaped > 0) console.log(`[terminals] reaped ${reaped} orphaned process group(s)`);
    try {
      writeFileSync(this.pidFile, "");
    } catch {
      /* best effort */
    }
  }
}
