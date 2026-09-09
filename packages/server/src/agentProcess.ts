import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { kcError, type KcError } from "@kirochrome/shared";
import type { ProviderConfig } from "@kirochrome/shared";
import { recordProcess } from "./processLedger.js";
import { RingBuffer } from "./ringBuffer.js";
import { resolveCommand } from "./resolve.js";
import { trace, traceEnabled } from "./trace.js";

export interface AgentProcess {
  child: ChildProcess;
  stream: Stream;
  stderr: RingBuffer;
  /** Resolves when the child exits, with its exit code or signal. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

/** Rung 1: is the binary actually there? */
export function resolveProvider(provider: ProviderConfig): { path: string } | KcError {
  const resolved = resolveCommand(provider.command);
  if ("path" in resolved) return resolved;
  return kcError("AGENT_NOT_FOUND", `Could not find '${provider.command}' on PATH.`, {
    stage: "resolve",
    remediation:
      `Set an absolute path for '${provider.name}' in your config. GUI apps often do not inherit ` +
      `your shell PATH, so a bare command name may work in a terminal but not here.`,
    detail: { command: provider.command, triedCount: resolved.tried.length, tried: resolved.tried.slice(0, 12) },
  });
}

/** Rung 2: does it start? */
export function spawnAgent(provider: ProviderConfig, executablePath: string): AgentProcess {
  const child = spawn(executablePath, provider.args, {
    cwd: provider.cwd ?? process.cwd(),
    env: { ...process.env, ...provider.env },
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group, so kill() can take down the whole tree. Killing only
    // the direct child leaves grandchildren holding pipes open — which is what
    // a "hung" terminal usually is.
    detached: process.platform !== "win32",
  });

  // Agents are detached, so they survive a crashed server; record them so the
  // next start can reap whatever they left running.
  if (child.pid !== undefined) {
    recordProcess(child.pid, [executablePath, ...provider.args].join(" "));
  }

  const stderr = new RingBuffer();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => stderr.append(chunk));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const stream = wrapStream(provider.id, child);

  return { child, stream, stderr, exited, kill: () => killTree(child) };
}

function wrapStream(providerId: string, child: ChildProcess): Stream {
  const base = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  if (!traceEnabled) return base;

  // Tap both directions without changing behaviour.
  return {
    readable: base.readable.pipeThrough(
      new TransformStream({
        transform(frame, controller) {
          trace("in", providerId, frame);
          controller.enqueue(frame);
        },
      }),
    ),
    writable: new WritableStream({
      async write(frame) {
        trace("out", providerId, frame);
        const writer = base.writable.getWriter();
        await writer.write(frame);
        writer.releaseLock();
      },
      close: () => base.writable.close(),
      abort: (reason) => base.writable.abort(reason),
    }),
  };
}

/**
 * Kills the child *and its descendants*.
 *
 * SIGTERM to the process group first, SIGKILL after a grace period. A plain
 * child.kill() leaves orphans behind, which is the classic cause of a command
 * that looks hung after you have "stopped" it.
 */
export function killTree(child: ChildProcess, graceMs = 2_000): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;

  const signal = (sig: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
      else process.kill(-pid, sig); // negative pid targets the whole group
    } catch {
      // Already gone.
    }
  };

  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), graceMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}
