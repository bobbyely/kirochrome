// A minimal ACP agent, used to exercise our client without needing a real one.
// Kept because it is the obvious test fixture for phase 1: deterministic,
// offline, and able to fake failures on demand.

import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

const app = agent({ name: "mock-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
    },
    agentInfo: { name: "mock-agent", title: "Mock Agent", version: "0.0.0" },
    authMethods: [],
  }))
  .onRequest("session/new", () => ({
    sessionId: `mock-session-${++seq}`,
    // Two shapes the composer must cope with: the legacy modes state, and the
    // newer generic config options.
    modes: {
      currentModeId: "code",
      availableModes: [
        { id: "code", name: "Code" },
        { id: "ask", name: "Ask" },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "mock-large",
        options: [
          { value: "mock-large", name: "Mock Large" },
          { value: "mock-small", name: "Mock Small", description: "Faster" },
        ],
      },
    ],
  }))
  .onRequest("session/prompt", async ({ params, client }) => {
    const notify = (update) =>
      client.notify("session/update", { sessionId: params.sessionId, update });

    for (const text of ["PROBE", "_", "OK"]) {
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
      await sleep(30);
    }

    // A tool call, so the client can prove it renders the full lifecycle.
    await notify({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read README.md",
      kind: "read",
      status: "in_progress",
    });
    await sleep(30);
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });

    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
await app.connect(stream).closed;
