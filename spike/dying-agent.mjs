import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
const app = agent({ name: "dying" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "dying", version: "0" }, authMethods: [],
  }))
  .onRequest("session/new", () => {
    setTimeout(() => process.exit(1), 800);   // dies shortly after connecting
    return { sessionId: "dying-1" };
  })
  .onRequest("session/prompt", () => ({ stopReason: "end_turn" }));
await app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))).closed;
