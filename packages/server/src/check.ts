import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  causeOf,
  kcError,
  type AuthMethod,
  type CheckStage,
  type KcError,
  type ProviderCheckResult,
  type ProviderConfig,
  type StageOutcome,
} from "@kirochrome/shared";
import { resolveProvider, spawnAgent, type AgentProcess } from "./agentProcess.js";
import { defaultCwd } from "./session.js";
import { withTimeout } from "./timeout.js";

/** JSON-RPC code an ACP agent returns when it needs the client to authenticate. */
const AUTH_REQUIRED = -32000;

const HANDSHAKE_TIMEOUT_MS = 60_000; // generous: `npx` may download on first run
const SESSION_TIMEOUT_MS = 30_000;

/**
 * Runs the setup check ladder against one provider.
 *
 * The ladder reports *which rung it fell off*, not a boolean. That is what
 * turns "the chat does nothing" into "the binary is not on PATH" or "you need
 * to log in".
 */
export async function checkProvider(provider: ProviderConfig): Promise<ProviderCheckResult> {
  const started = Date.now();
  const stages: StageOutcome[] = [];
  let stage: CheckStage | null = null;
  let agent: AgentProcess | null = null;

  /** Times a rung and records its outcome, so the UI can show progress. */
  const rung = async <T>(name: CheckStage, run: () => Promise<T> | T): Promise<T> => {
    stage = name;
    const t0 = Date.now();
    try {
      const value = await run();
      stages.push({ stage: name, ok: true, ms: Date.now() - t0 });
      return value;
    } catch (err) {
      stages.push({ stage: name, ok: false, ms: Date.now() - t0 });
      throw err;
    }
  };

  const finish = (extra: Partial<ProviderCheckResult>): ProviderCheckResult => {
    const stderrTail = agent?.stderr.tail();
    return {
      providerId: provider.id,
      status: extra.error ? "failed" : "ok",
      stage,
      stages,
      stderrTail,
      checkedAt: Date.now(),
      durationMs: Date.now() - started,
      ...extra,
      ...(extra.error ? { error: withStderrHint(extra.error, stderrTail) } : {}),
    };
  };

  try {
    // --- rung 1: resolve ---
    const resolved = await rung("resolve", () => {
      const r = resolveProvider(provider);
      if ("code" in r) throw r;
      return r;
    });

    // --- rung 2: spawn ---
    agent = await rung("spawn", async () => {
      const proc = spawnAgent(provider, resolved.path);
      await new Promise<void>((resolve, reject) => {
        proc.child.once("spawn", () => resolve());
        proc.child.once("error", (err) =>
          reject(
            kcError("AGENT_SPAWN_FAILED", `Could not start '${resolved.path}'.`, {
              stage: "spawn",
              cause: causeOf(err),
              detail: { path: resolved.path, args: provider.args },
            }),
          ),
        );
      });
      return proc;
    });

    const proc = agent;

    // The remaining rungs all need the connection open, so they run inside
    // connectWith and the result is carried out.
    const app = client({ name: "kirochrome" })
      // A check must never block on a permission prompt; refuse and move on.
      .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));

    return await app.connectWith(proc.stream, async (acp) => {
      // --- rung 3: initialize ---
      const init = await rung("initialize", () =>
        withTimeout(
          acp.request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
            clientInfo: { name: "kirochrome", version: "0.0.0" },
          }),
          HANDSHAKE_TIMEOUT_MS,
          () =>
            kcError("AGENT_HANDSHAKE_TIMEOUT", `'${provider.name}' did not complete the ACP handshake in time.`, {
              stage: "initialize",
              detail: { timeoutMs: HANDSHAKE_TIMEOUT_MS, command: provider.command, args: provider.args },
            }),
        ),
      );

      const authMethods = (init.authMethods ?? []) as AuthMethod[];
      const agentInfo = init.agentInfo ?? undefined;

      // --- rung 4: version ---
      await rung("version", () => {
        if (init.protocolVersion !== PROTOCOL_VERSION) {
          throw kcError(
            "AGENT_PROTOCOL_MISMATCH",
            `'${provider.name}' speaks ACP v${init.protocolVersion}; we speak v${PROTOCOL_VERSION}.`,
            { stage: "version", detail: { agent: init.protocolVersion, client: PROTOCOL_VERSION } },
          );
        }
      });

      // --- rung 5: authenticate ---
      // Only acts when the user has chosen a method. Agents that need auth but
      // have no method chosen fail at rung 6 with -32000, which we map back here.
      await rung("authenticate", async () => {
        if (!provider.authMethodId) return;
        try {
          await acp.request("authenticate", { methodId: provider.authMethodId });
        } catch (err) {
          throw authError(provider, authMethods, err);
        }
      });

      // --- rung 6: session ---
      // This is the rung that makes "assume the draft will work" safe: it
      // exercises the exact call the new-chat flow depends on.
      const session = await rung("session", async () => {
        try {
          return await withTimeout(
            acp.buildSession(provider.cwd ?? defaultCwd()).start(),
            SESSION_TIMEOUT_MS,
            () =>
              kcError("RPC_TIMEOUT", `'${provider.name}' did not answer session/new in time.`, {
                stage: "session",
                detail: { timeoutMs: SESSION_TIMEOUT_MS },
              }),
          );
        } catch (err) {
          if (isKcError(err)) throw err;
          if (rpcCode(err) === AUTH_REQUIRED) throw authError(provider, authMethods, err);
          throw kcError("AGENT_SESSION_FAILED", `'${provider.name}' refused to open a session.`, {
            stage: "session",
            cause: causeOf(err),
            detail: { rpc: rpcDetail(err) },
          });
        }
      });

      // --- rung 7: capabilities ---
      const response = session.newSessionResponse as Record<string, unknown>;
      await rung("capabilities", () => session.dispose?.());

      return finish({
        agentInfo,
        protocolVersion: init.protocolVersion,
        capabilities: init.agentCapabilities,
        authMethods,
        configOptions: response["configOptions"] ?? null,
        modes: session.modes ?? null,
      });
    });
  } catch (err) {
    const error = isKcError(err)
      ? err
      : kcError("INTERNAL", `Unexpected failure checking '${provider.name}'.`, {
          stage: stage ?? undefined,
          cause: causeOf(err),
        });
    return finish({ error });
  } finally {
    agent?.kill();
  }
}

/**
 * Some agents fail for reasons only their stderr explains. Where we recognise
 * one, promote it into remediation so the user is not left reading a stack
 * trace. A hint only — it never changes the error code or control flow.
 */
const STDERR_HINTS: Array<{ match: RegExp; hint: string }> = [
  {
    match: /cannot be launched inside another Claude Code session/i,
    hint: "Start the KiroChrome server from a normal terminal rather than from inside a Claude Code session, then re-run this check.",
  },
  {
    match: /not logged in|please run .*login|authentication/i,
    hint: "The agent looks logged out. Log in with its own CLI, then re-run this check.",
  },
];

function withStderrHint(error: KcError, stderrTail: string | undefined): KcError {
  if (!stderrTail) return error;
  const hit = STDERR_HINTS.find((h) => h.match.test(stderrTail));
  if (!hit) return error;
  return { ...error, remediation: `${hit.hint} (${error.remediation ?? ""})`.trim() };
}

function authError(provider: ProviderConfig, authMethods: AuthMethod[], err: unknown): KcError {
  const options = authMethods.map((m) => m.description ?? m.name).join("; ");
  return kcError("AGENT_AUTH_REQUIRED", `'${provider.name}' needs you to log in first.`, {
    // Reported against `authenticate` even though it surfaced at `session`,
    // because that is the rung the user has to act on.
    stage: "authenticate",
    remediation: options
      ? `Authenticate with the agent, then re-run this check. Available: ${options}`
      : "The agent requires authentication but advertised no methods. Log in using its own CLI, then re-check.",
    detail: { authMethods, rpc: rpcDetail(err) },
    cause: causeOf(err),
  });
}

const isKcError = (err: unknown): err is KcError =>
  typeof err === "object" && err !== null && "code" in err && "message" in err;

function rpcCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "number" ? code : undefined;
}

function rpcDetail(err: unknown): unknown {
  const e = err as { code?: unknown; message?: unknown; data?: unknown };
  if (e?.code === undefined && e?.data === undefined) return undefined;
  return { code: e.code, message: e.message, data: e.data };
}
