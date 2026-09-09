import { client, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import {
  causeOf,
  kcError,
  type KcError,
  type KcEvent,
  type KcEventInput,
  type ProviderConfig,
  type SessionSummary,
} from "@kirochrome/shared";
import { resolveProvider, spawnAgent, type AgentProcess } from "./agentProcess.js";

/** Deltas are buffered this long before becoming one event. See docs/DESIGN.md. */
const TEXT_FLUSH_MS = 250;
const HANDSHAKE_TIMEOUT_MS = 60_000;

type Subscriber = (events: KcEvent[]) => void;

/**
 * One conversation: an agent subprocess, an ACP connection, and an append-only
 * event log.
 *
 * A turn is owned by the session, not by any socket — if the browser
 * disconnects mid-turn the turn keeps running and keeps appending, and the
 * client catches up by `seq` when it returns.
 */
export class Session {
  readonly id: string;
  private readonly log: KcEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private seq = 0;
  private busy = false;

  private proc: AgentProcess | null = null;
  private connection: ClientConnection | null = null;
  private agentSessionId: string | null = null;

  private textBuffer = "";
  private flushTimer: NodeJS.Timeout | null = null;

  private constructor(
    id: string,
    readonly provider: ProviderConfig,
    readonly cwd: string,
  ) {
    this.id = id;
  }

  /** Spawns the agent and completes the ACP handshake. */
  static async open(id: string, provider: ProviderConfig): Promise<Session> {
    const cwd = provider.cwd ?? process.cwd();
    const session = new Session(id, provider, cwd);
    await session.connect();
    return session;
  }

  private async connect(): Promise<void> {
    const resolved = resolveProvider(this.provider);
    if ("code" in resolved) throw resolved;

    const proc = spawnAgent(this.provider, resolved.path);
    this.proc = proc;

    // A dead agent must become a visible event, never a silent spinner.
    void proc.exited.then(({ code, signal }) => {
      this.flushText();
      this.append({ type: "agent_exited", code, signal });
      this.busy = false;
    });

    const app = client({ name: "kirochrome" })
      .onNotification("session/update", ({ params }) => this.onUpdate(params.update))
      // Real approval UI is phase 5; until then refuse rather than hang.
      .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));

    this.connection = app.connect(proc.stream);

    const init = await withTimeout(
      this.connection.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "kirochrome", version: "0.0.0" },
      }),
      HANDSHAKE_TIMEOUT_MS,
      () =>
        kcError("AGENT_HANDSHAKE_TIMEOUT", `'${this.provider.name}' did not complete the handshake.`, {
          detail: { timeoutMs: HANDSHAKE_TIMEOUT_MS },
        }),
    );

    if (init.protocolVersion !== PROTOCOL_VERSION) {
      throw kcError(
        "AGENT_PROTOCOL_MISMATCH",
        `'${this.provider.name}' speaks ACP v${init.protocolVersion}; we speak v${PROTOCOL_VERSION}.`,
      );
    }

    const active = await this.connection.agent.buildSession(this.cwd).start();
    this.agentSessionId = active.sessionId;
  }

  /** Sends a prompt and returns once the turn completes. */
  async prompt(text: string): Promise<void> {
    if (this.busy) {
      this.emitError(kcError("INTERNAL", "A turn is already running in this session."));
      return;
    }
    const connection = this.connection;
    const agentSessionId = this.agentSessionId;
    if (!connection || !agentSessionId) {
      this.emitError(kcError("AGENT_EXITED", "The agent is not connected."));
      return;
    }

    this.busy = true;
    this.append({ type: "user_message", text });
    this.append({ type: "turn_start" });

    try {
      const res = await connection.agent.request("session/prompt", {
        sessionId: agentSessionId,
        prompt: [{ type: "text", text }],
      });
      this.flushText();
      this.append({ type: "turn_end", stopReason: res.stopReason ?? "end_turn" });
    } catch (err) {
      this.flushText();
      this.emitError(
        kcError("RPC_ERROR", `'${this.provider.name}' failed during the turn.`, {
          cause: causeOf(err),
          detail: { stderr: this.proc?.stderr.tail() },
        }),
      );
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.agentSessionId) return;
    try {
      await this.connection.agent.request("session/cancel", { sessionId: this.agentSessionId });
    } catch (err) {
      this.emitError(kcError("RPC_ERROR", "Cancel failed.", { cause: causeOf(err) }));
    }
  }

  /** Handles one ACP session/update, coalescing text and passing the rest through. */
  private onUpdate(update: unknown): void {
    const u = update as { sessionUpdate?: string; content?: { type?: string; text?: string } };

    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      this.bufferText(u.content.text ?? "");
      return;
    }
    // Ordering matters: flush pending text before any other event lands.
    this.flushText();
    this.append({ type: "agent_update", update });
  }

  private bufferText(text: string): void {
    this.textBuffer += text;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushText(), TEXT_FLUSH_MS);
  }

  private flushText(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.textBuffer.length === 0) return;
    const text = this.textBuffer;
    this.textBuffer = "";
    this.append({ type: "agent_text", text });
  }

  private emitError(error: KcError): void {
    this.append({ type: "error", error });
  }

  /** The only way anything enters the log. Append-only, monotonic seq. */
  private append(event: KcEventInput): void {
    const full = { ...event, seq: ++this.seq, ts: Date.now() } as KcEvent;
    this.log.push(full);
    for (const notify of this.subscribers) notify([full]);
  }

  /** Everything after `sinceSeq` — the whole of catch-up-after-reconnect. */
  eventsSince(sinceSeq: number): KcEvent[] {
    return this.log.filter((e) => e.seq > sinceSeq);
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      providerId: this.provider.id,
      providerName: this.provider.name,
      cwd: this.cwd,
      busy: this.busy,
      lastSeq: this.seq,
    };
  }

  close(): void {
    this.flushText();
    this.connection?.close();
    this.proc?.kill();
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => KcError): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
