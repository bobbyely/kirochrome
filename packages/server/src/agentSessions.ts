import { client, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import {
  advertisesSessionList,
  causeOf,
  kcError,
  type AgentSessionInfo,
  type ProviderConfig,
} from "@kirochrome/shared";
import { resolveProvider, spawnAgent, type AgentProcess } from "./agentProcess.js";
import { withTimeout } from "./timeout.js";

const HANDSHAKE_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 20_000;
/**
 * Paging caps. `session/list` is cursor-paginated and the spec sets no page
 * size, so an agent with thousands of conversations could otherwise page for a
 * very long time. We stop, and we say that we stopped.
 */
const MAX_PAGES = 10;
const MAX_SESSIONS = 200;

export interface AgentSessionList {
  supported: boolean;
  sessions: AgentSessionInfo[];
  /** True when the agent had more than we were willing to fetch. */
  truncated: boolean;
}

/**
 * Asks a provider which conversations it is holding of its own.
 *
 * A short-lived probe: spawn, `initialize`, page through `session/list`, kill.
 * The same shape as the check ladder, and for the same reason — this runs
 * before any conversation exists, so there is no live connection to borrow.
 *
 * Returns `supported: false` rather than throwing when the agent did not
 * advertise `sessionCapabilities.list`. An agent that keeps no history of its
 * own is a normal agent, not a failure.
 */
export async function listAgentSessions(
  provider: ProviderConfig,
  opts: { listTimeoutMs?: number } = {},
): Promise<AgentSessionList> {
  const resolved = resolveProvider(provider);
  if ("code" in resolved) throw resolved;

  let agent: AgentProcess | null = null;
  try {
    const proc = spawnAgent(provider, resolved.path);
    agent = proc;

    // A probe must never block on a human. It asks nothing that should prompt,
    // but an agent that prompts anyway would hang the request.
    const app = client({ name: "kirochrome" }).onRequest("session/request_permission", () => ({
      outcome: { outcome: "cancelled" },
    }));

    return await app.connectWith(proc.stream, async (acp) => {
      const init = await withTimeout(
        acp.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: "kirochrome", version: "0.0.0" },
        }),
        HANDSHAKE_TIMEOUT_MS,
        () =>
          kcError("AGENT_HANDSHAKE_TIMEOUT", `'${provider.name}' did not complete the handshake.`, {
            detail: { timeoutMs: HANDSHAKE_TIMEOUT_MS },
          }),
      );

      if (!advertisesSessionList(init.agentCapabilities)) {
        return { supported: false, sessions: [], truncated: false };
      }

      const timeoutMs = opts.listTimeoutMs ?? LIST_TIMEOUT_MS;
      const page = (cursor: string | undefined): Promise<unknown> =>
        withTimeout(
          acp.request("session/list", cursor === undefined ? {} : { cursor }),
          timeoutMs,
          () =>
            kcError("RPC_TIMEOUT", `'${provider.name}' did not answer session/list in time.`, {
              remediation:
                "The agent advertised session/list but did not reply. Re-run its setup check. " +
                "Starting a new chat still works — listing is an extra, not a prerequisite.",
              detail: { timeoutMs, cursor: cursor ?? null },
            }),
        );

      const sessions: AgentSessionInfo[] = [];
      let cursor: string | undefined;
      let truncated = false;

      for (let n = 0; n < MAX_PAGES; n++) {
        const { entries, nextCursor } = parsePage(await asked(page(cursor), provider));
        const room = MAX_SESSIONS - sessions.length;
        sessions.push(...entries.slice(0, room));
        // More on this page than we kept, or more pages than we will fetch.
        if (entries.length > room) {
          truncated = true;
          break;
        }
        if (nextCursor === undefined) break;
        if (n === MAX_PAGES - 1 || sessions.length >= MAX_SESSIONS) {
          truncated = true;
          break;
        }
        cursor = nextCursor;
      }

      return { supported: true, sessions, truncated };
    });
  } finally {
    // Invariant 6: the probe's process group is killed on every route out.
    agent?.kill();
  }
}

/** Turns a JSON-RPC rejection into a typed error, preserving our own. */
async function asked(request: Promise<unknown>, provider: ProviderConfig): Promise<unknown> {
  try {
    return await request;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && "message" in err) throw err;
    const rpc = err as { code?: unknown; message?: unknown; data?: unknown };
    throw kcError("RPC_ERROR", `'${provider.name}' could not list its own conversations.`, {
      remediation:
        "The agent advertised sessionCapabilities.list but the call failed. Its own CLI is still " +
        "the way into those conversations, and new chats here are unaffected.",
      detail: { rpc: { code: rpc?.code, message: rpc?.message, data: rpc?.data } },
      cause: causeOf(err),
    });
  }
}

/** Narrows one `session/list` response. Agent payloads are narrowed, not validated. */
function parsePage(raw: unknown): { entries: AgentSessionInfo[]; nextCursor: string | undefined } {
  const body = raw as { sessions?: unknown; nextCursor?: unknown } | null | undefined;
  const list = Array.isArray(body?.sessions) ? body.sessions : [];
  return {
    entries: list.map(toSessionInfo).filter((info): info is AgentSessionInfo => info !== null),
    nextCursor: typeof body?.nextCursor === "string" && body.nextCursor ? body.nextCursor : undefined,
  };
}

/**
 * Narrows one `SessionInfo`, dropping anything missing the two fields the
 * schema makes required.
 *
 * ACP marks the array skip-invalid-items, so one malformed entry must not cost
 * the user the rest of the list.
 */
function toSessionInfo(entry: unknown): AgentSessionInfo | null {
  const info = entry as { sessionId?: unknown; cwd?: unknown; title?: unknown; updatedAt?: unknown };
  if (typeof info?.sessionId !== "string" || !info.sessionId) return null;
  if (typeof info?.cwd !== "string" || !info.cwd) return null;
  return {
    sessionId: info.sessionId,
    cwd: info.cwd,
    title: typeof info.title === "string" ? info.title : null,
    updatedAt: typeof info.updatedAt === "string" ? info.updatedAt : null,
  };
}
