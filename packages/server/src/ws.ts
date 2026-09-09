import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { causeOf, kcError, type ClientMessage, type KcError, type ServerMessage } from "@kirochrome/shared";
import { loadConfig } from "./config.js";
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
      const session = await sessions.open(provider);
      send({ type: "session_opened", session: session.summary() });
      return;
    }

    case "subscribe": {
      const session = sessions.get(msg.sessionId);
      // Backlog first, then live updates — so nothing is missed in between.
      send({ type: "events", sessionId: session.id, events: session.eventsSince(msg.sinceSeq) });
      unsubscribers.push(
        session.subscribe((events) => send({ type: "events", sessionId: session.id, events })),
      );
      send({ type: "session_state", session: session.summary() });
      return;
    }

    case "prompt": {
      const session = sessions.get(msg.sessionId);
      send({ type: "session_state", session: { ...session.summary(), busy: true } });
      await session.prompt(msg.text);
      send({ type: "session_state", session: session.summary() });
      return;
    }

    case "cancel": {
      await sessions.get(msg.sessionId).cancel();
      return;
    }
  }
}
