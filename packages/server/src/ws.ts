import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { causeOf, kcError, type ClientMessage, type KcError, type ServerMessage } from "@kirochrome/shared";
import { loadConfig } from "./config.js";
import { defaultCwd } from "./session.js";
import { SessionManager } from "./sessionManager.js";

/**
 * WebSocket transport for chat.
 *
 * The socket is a view onto sessions, never their owner: subscriptions are torn
 * down on disconnect but the session and any running turn survive, and a
 * returning client catches up by `seq`.
 */
export function attachWebSocket(
  server: Server,
  sessions: SessionManager,
  originAllowed: (req: IncomingMessage) => boolean,
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!originAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => handleConnection(ws, sessions));
}

function handleConnection(ws: WebSocket, sessions: SessionManager): void {
  const unsubscribers: Array<() => void> = [];
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  // Keep every client's conversation list live, so status shows without a refresh.
  unsubscribers.push(sessions.onChange(() => send({ type: "sessions", sessions: sessions.list() })));
  const fail = (error: KcError, sessionId?: string) => send({ type: "error", error, sessionId });

  ws.on("message", (raw) => {
    void (async () => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch (err) {
        return fail(kcError("INTERNAL", "Malformed message.", { cause: causeOf(err) }));
      }

      try {
        await dispatch(msg, sessions, send, unsubscribers);
      } catch (err) {
        const error =
          typeof err === "object" && err !== null && "code" in err
            ? (err as KcError)
            : kcError("INTERNAL", "Unhandled server error.", { cause: causeOf(err) });
        fail(error, "sessionId" in msg ? msg.sessionId : undefined);
      }
    })();
  });

  ws.on("close", () => {
    // Drop subscriptions only. Sessions and in-flight turns outlive the socket.
    for (const off of unsubscribers) off();
    unsubscribers.length = 0;
  });
}

async function dispatch(
  msg: ClientMessage,
  sessions: SessionManager,
  send: (msg: ServerMessage) => void,
  unsubscribers: Array<() => void>,
): Promise<void> {
  switch (msg.type) {
    case "open": {
      const provider = loadConfig().providers.find((p) => p.id === msg.providerId);
      if (!provider) {
        throw kcError("PROVIDER_UNKNOWN", `No provider configured with id '${msg.providerId}'.`);
      }
      const session = await sessions.open(provider, msg.cwd);
      send({ type: "session_opened", session: session.summary() });
      return;
    }

    case "subscribe": {
      // Backlog first, then live updates — so nothing is missed in between.
      // Works for restored sessions too; those just have nothing live to add.
      send({ type: "events", sessionId: msg.sessionId, events: sessions.eventsSince(msg.sessionId, msg.sinceSeq) });
      const live = sessions.getLive(msg.sessionId);
      if (live) {
        unsubscribers.push(live.subscribe((events) => send({ type: "events", sessionId: live.id, events })));
        unsubscribers.push(live.onStateChange(() => send({ type: "session_state", session: live.summary() })));
      }
      send({ type: "session_state", session: sessions.summary(msg.sessionId) });
      return;
    }

    case "rename_session": {
      sessions.rename(msg.sessionId, msg.title);
      send({ type: "sessions", sessions: sessions.list() });
      return;
    }

    case "list_sessions": {
      send({ type: "sessions", sessions: sessions.list() });
      return;
    }

    case "list_workspaces": {
      // Directories previously worked in, so a new chat can be pointed at one.
      send({ type: "workspaces", workspaces: sessions.recentWorkspaces(), current: defaultCwd() });
      return;
    }

    case "resume": {
      const record = sessions.summary(msg.sessionId);
      const provider = loadConfig().providers.find((p) => p.id === record.providerId);
      if (!provider) {
        throw kcError(
          "PROVIDER_UNKNOWN",
          `'${record.providerName}' is no longer configured, so this conversation cannot be reopened.`,
        );
      }
      const resumed = await sessions.resume(msg.sessionId, provider);
      unsubscribers.push(
        resumed.subscribe((events) => send({ type: "events", sessionId: resumed.id, events })),
      );
      send({ type: "events", sessionId: resumed.id, events: resumed.eventsSince(msg.sinceSeq) });
      send({ type: "session_state", session: resumed.summary() });
      return;
    }

    case "prompt": {
      const session = sessions.requireLive(msg.sessionId);
      send({ type: "session_state", session: { ...session.summary(), busy: true } });
      await session.prompt(msg.text);
      send({ type: "session_state", session: session.summary() });
      return;
    }

    case "set_config_option": {
      const session = sessions.requireLive(msg.sessionId);
      await session.setConfigOption(msg.configId, msg.value);
      send({ type: "session_state", session: session.summary() });
      return;
    }

    case "permission_response": {
      sessions.requireLive(msg.sessionId).resolvePermission(msg.requestId, msg.optionId);
      return;
    }

    case "set_auto_approve": {
      const session = sessions.requireLive(msg.sessionId);
      session.setAutoApprove(msg.enabled);
      send({ type: "session_state", session: session.summary() });
      return;
    }

    case "unqueue": {
      const session = sessions.requireLive(msg.sessionId);
      session.unqueue(msg.index);
      send({ type: "session_state", session: session.summary() });
      return;
    }

    case "cancel": {
      await sessions.requireLive(msg.sessionId).cancel();
      return;
    }
  }
}
