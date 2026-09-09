import { randomUUID } from "node:crypto";
import { client, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import {
  causeOf,
  kcError,
  type KcError,
  type KcEvent,
  type KcEventInput,
  type ConfigOption,
  type ProviderConfig,
  type SessionRecord,
  type SessionSummary,
} from "@kirochrome/shared";
import { resolveProvider, spawnAgent, type AgentProcess } from "./agentProcess.js";
import { normaliseConfigOptions } from "./configOptions.js";
import type { Store } from "./store.js";
import { TerminalRegistry } from "./terminals.js";

/**
 * The older per-kind config methods, by option id.
 *
 * Note `session/set_model` is not in the SDK's v1 method registry — model
 * selection moved to `session/set_config_option` — but Kiro's docs still list
 * it, so it stays as a fallback. Outbound requests accept any method name.
 */
const LEGACY_SETTERS: Record<string, { method: string; param: string }> = {
  model: { method: "session/set_model", param: "modelId" },
  mode: { method: "session/set_mode", param: "modeId" },
};

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
  private readonly stateListeners = new Set<() => void>();
  private seq = 0;
  private busy = false;

  private proc: AgentProcess | null = null;
  private connection: ClientConnection | null = null;
  private agentSessionId: string | null = null;

  private textBuffer = "";
  private flushTimer: NodeJS.Timeout | null = null;
  /**
   * True while `session/load` is replaying the agent's own history.
   *
   * The agent re-sends every past message as `session/update` before answering
   * the load. We already hold that history in our log, so those updates must be
   * discarded — appending them would duplicate the whole transcript.
   */
  private replaying = false;
  /** Permission requests waiting on the UI, keyed by request id. */
  private readonly pendingPermissions = new Map<string, (optionId: string | null) => void>();
  private autoApprove = false;
  private readonly terminals = new TerminalRegistry();

  private title: string | null = null;
  private configOptions: ConfigOption[] = [];

  private constructor(
    id: string,
    readonly provider: ProviderConfig,
    readonly cwd: string,
    private readonly store: Store,
  ) {
    this.id = id;
  }

  /** Spawns the agent, completes the ACP handshake and records the session. */
  static async open(
    id: string,
    provider: ProviderConfig,
    store: Store,
    cwdOverride?: string,
  ): Promise<Session> {
    // Explicit choice wins, then the provider's pin, then the launch directory.
    const cwd = cwdOverride ?? provider.cwd ?? defaultCwd();
    const session = new Session(id, provider, cwd, store);
    const now = Date.now();
    store.upsertSession({
      id,
      agentSessionId: null,
      providerId: provider.id,
      providerName: provider.name,
      cwd,
      title: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await session.connect();
    return session;
  }

  /**
   * Re-attaches an agent to a conversation restored from disk.
   *
   * Requires the agent to advertise `loadSession`; without it the transcript
   * stays readable but cannot be continued.
   */
  static async resume(
    record: SessionRecord,
    provider: ProviderConfig,
    store: Store,
  ): Promise<Session> {
    if (!record.agentSessionId) {
      throw kcError("SESSION_NOT_LIVE", "This conversation has no agent session id recorded.", {
        remediation: "It was created before its agent finished starting. Start a new chat instead.",
      });
    }
    const session = new Session(record.id, provider, record.cwd, store);
    session.title = record.title;
    session.agentSessionId = record.agentSessionId;
    session.seq = store.lastSeq(record.id);
    session.log.push(...store.eventsSince(record.id, 0));
    await session.connect({ loadSessionId: record.agentSessionId });
    return session;
  }

  private async connect(opts: { loadSessionId?: string } = {}): Promise<void> {
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
      .onRequest("session/request_permission", ({ params }) => this.requestPermission(params))
      // We advertise terminal: true, so the agent delegates command execution
      // to us and their lifetimes become our responsibility.
      .onRequest("terminal/create", ({ params }) => this.terminals.create(params))
      .onRequest("terminal/output", ({ params }) => this.terminals.output(params.terminalId))
      .onRequest("terminal/wait_for_exit", ({ params }) => this.terminals.waitForExit(params.terminalId))
      .onRequest("terminal/kill", ({ params }) => {
        this.terminals.kill(params.terminalId);
        return {};
      })
      .onRequest("terminal/release", ({ params }) => {
        this.terminals.release(params.terminalId);
        return {};
      });

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

    if (opts.loadSessionId) {
      const capabilities = init.agentCapabilities as { loadSession?: boolean } | undefined;
      if (!capabilities?.loadSession) {
        throw kcError(
          "SESSION_NOT_LIVE",
          `'${this.provider.name}' cannot reopen past conversations.`,
          { remediation: "This agent does not support session/load. Start a new chat instead." },
        );
      }
      // Discard the agent's replay; our log is already the transcript.
      this.replaying = true;
      try {
        await this.connection.agent.request("session/load", {
          sessionId: opts.loadSessionId,
          cwd: this.cwd,
          mcpServers: [],
        });
      } finally {
        this.replaying = false;
        this.textBuffer = "";
      }
      this.append({ type: "resumed" });
      return;
    }

    const active = await this.connection.agent.buildSession(this.cwd).start();
    this.agentSessionId = active.sessionId;
    const response = active.newSessionResponse as Record<string, unknown>;
    this.configOptions = normaliseConfigOptions(response);
    this.persistMeta();
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
    // First message names the session, so the list is browsable.
    if (this.title === null) {
      this.title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
      this.persistMeta();
    }
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

  /**
   * Changes one of the agent's advertised settings.
   *
   * Writes back in whichever dialect the agent used: the generic
   * `session/set_config_option`, or the older per-kind methods.
   */
  async setConfigOption(id: string, value: string | boolean): Promise<void> {
    const connection = this.connection;
    const agentSessionId = this.agentSessionId;
    if (!connection || !agentSessionId) {
      this.emitError(kcError("AGENT_EXITED", "The agent is not connected."));
      return;
    }

    // `session/set_config_option` is the standard; the per-kind methods are the
    // older dialect that Kiro still documents. Try the standard first and fall
    // back on failure rather than guessing from the session/new response —
    // agents mid-migration do not always answer both consistently.
    try {
      try {
        await connection.agent.request("session/set_config_option", {
          sessionId: agentSessionId,
          configId: id,
          value,
        });
      } catch (modernErr) {
        const legacy = LEGACY_SETTERS[id];
        if (!legacy) throw modernErr;
        await connection.agent.request(legacy.method, {
          sessionId: agentSessionId,
          [legacy.param]: value,
        });
      }
      this.configOptions = this.configOptions.map((o) =>
        o.id === id ? { ...o, currentValue: value } : o,
      );
    } catch (err) {
      this.emitError(
        kcError("RPC_ERROR", `Could not change ${id}.`, {
          cause: causeOf(err),
          detail: { stderr: this.proc?.stderr.tail() },
        }),
      );
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
    if (this.replaying) return; // history we already have
    const u = update as { sessionUpdate?: string; content?: { type?: string; text?: string } };

    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      this.bufferText(u.content.text ?? "");
      return;
    }
    // Ordering matters: flush pending text before any other event lands.
    this.flushText();

    const t = update as {
      sessionUpdate?: string;
      toolCallId?: string;
      title?: string;
      kind?: string;
      status?: string;
    };

    // Agents name their own sessions. Prefer that over our first-message
    // fallback — it is better, and it costs nothing extra.
    if (t.sessionUpdate === "session_info_update" && t.title) {
      this.title = t.title;
      this.persistMeta();
      this.notifyState();
    }
    if (t.sessionUpdate === "tool_call" && t.toolCallId) {
      this.append({
        type: "tool_call",
        toolCallId: t.toolCallId,
        title: t.title ?? "Tool call",
        kind: t.kind ?? "other",
        status: t.status ?? "pending",
        raw: update,
      });
      return;
    }
    if (t.sessionUpdate === "tool_call_update" && t.toolCallId) {
      this.append({
        type: "tool_call_update",
        toolCallId: t.toolCallId,
        ...(t.status ? { status: t.status } : {}),
        raw: update,
      });
      return;
    }
    this.append({ type: "agent_update", update });
  }

  /**
   * Asks the user to approve a tool call.
   *
   * The ACP request stays open until the UI answers, so the agent is blocked
   * exactly as long as the human takes. The prompt is an event like anything
   * else, which is what makes it survive a page refresh mid-decision.
   */
  private async requestPermission(params: {
    // Nullable fields mirror the ACP schema, which uses null rather than omission.
    options?: Array<{ optionId: string; name: string; kind: string }>;
    toolCall?: { title?: string | null };
  }): Promise<
    | { outcome: { outcome: "cancelled" } }
    | { outcome: { outcome: "selected"; optionId: string } }
  > {
    const options = (params.options ?? []).map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    const title = params.toolCall?.title ?? "Allow this action?";

    if (this.autoApprove) {
      const allow = options.find((o) => o.kind.startsWith("allow"));
      if (allow) return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
    }

    const requestId = randomUUID();
    this.flushText();
    this.append({ type: "permission_request", requestId, title, options });

    const optionId = await new Promise<string | null>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
    });
    this.pendingPermissions.delete(requestId);

    if (optionId === null) {
      this.append({ type: "permission_resolved", requestId, optionId, outcome: "cancelled" });
      return { outcome: { outcome: "cancelled" as const } };
    }
    this.append({ type: "permission_resolved", requestId, optionId, outcome: "selected" });
    return { outcome: { outcome: "selected" as const, optionId } };
  }

  /** Answers an outstanding permission request. */
  resolvePermission(requestId: string, optionId: string | null): void {
    this.pendingPermissions.get(requestId)?.(optionId);
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
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

  /** The only way anything enters the log. Append-only, monotonic seq, durable. */
  private append(event: KcEventInput): void {
    const full = { ...event, seq: ++this.seq, ts: Date.now() } as KcEvent;
    this.log.push(full);
    try {
      this.store.appendEvent(this.id, full);
    } catch (err) {
      // Never let a write failure take down a live turn; the in-memory log
      // still serves this session, and the failure is visible in the console.
      console.error(`[session ${this.id}] failed to persist event ${full.seq}:`, err);
    }
    for (const notify of this.subscribers) notify([full]);
  }

  private persistMeta(): void {
    const now = Date.now();
    this.store.upsertSession({
      id: this.id,
      agentSessionId: this.agentSessionId,
      providerId: this.provider.id,
      providerName: this.provider.name,
      cwd: this.cwd,
      title: this.title,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Everything after `sinceSeq` — the whole of catch-up-after-reconnect. */
  eventsSince(sinceSeq: number): KcEvent[] {
    return this.log.filter((e) => e.seq > sinceSeq);
  }

  /** Notified when session metadata changes outside the event stream. */
  onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private notifyState(): void {
    for (const fn of this.stateListeners) fn();
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
      title: this.title,
      live: true,
      configOptions: this.configOptions,
      autoApprove: this.autoApprove,
    };
  }

  close(): void {
    // Release anything blocked on a human; the agent is going away regardless.
    for (const resolve of this.pendingPermissions.values()) resolve(null);
    this.pendingPermissions.clear();
    this.terminals.releaseAll();
    this.flushText();
    this.connection?.close();
    this.proc?.kill();
  }
}

/**
 * Where the agent should work.
 *
 * `process.cwd()` is wrong here: npm runs a workspace script with the cwd set
 * to the package directory, so an agent started via `npm start` would be
 * scoped to packages/server rather than the project. INIT_CWD is where the
 * user actually invoked npm.
 */
export function defaultCwd(): string {
  return process.env.KIROCHROME_CWD ?? process.env.INIT_CWD ?? process.cwd();
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
