// A test fixture: an ACP agent that spawns its own long-lived background
// process, the way a real agent might start a dev server or file watcher
// outside ACP's terminal methods. Used to check that killing the server does
// not leave those behind.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

spawn("sh", ["-c", "sleep 8888"], { stdio: "ignore" });

const app = agent({ name: "greedy" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "greedy", version: "0" },
    authMethods: [],
  }))
  .onRequest("session/new", () => ({ sessionId: "greedy-1" }))
  .onRequest("session/prompt", () => ({ stopReason: "end_turn" }));

await app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))).closed;
