// A minimal ACP agent, used to exercise our client without needing a real one.
// Kept because it is the obvious test fixture for phase 1: deterministic,
// offline, and able to fake failures on demand.

import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

const cancelled = new Set();

const app = agent({ name: "mock-agent" })
  // ACP sends cancellation as a notification, not a request.
  .onNotification("session/cancel", ({ params }) => {
    cancelled.add(params.sessionId);
  })
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
  // Replays history the way a real agent does, so the client's replay
  // suppression can be tested.
  .onRequest("session/set_config_option", ({ params }) => ({
    configOptions: [{ id: params.configId, currentValue: params.value }],
  }))
  .onRequest("session/set_mode", () => ({}))
  .onRequest("session/load", async ({ params, client }) => {
    const notify = (update) =>
      client.notify("session/update", { sessionId: params.sessionId, update });
    for (const text of ["OLD ", "HISTORY"]) {
      await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    }
    return {};
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const notify = (update) =>
      client.notify("session/update", { sessionId: params.sessionId, update });

    // A long turn, so cancellation has something to interrupt.
    if (params.prompt?.[0]?.text === "long") {
      cancelled.delete(params.sessionId);
      for (let i = 0; i < 100; i++) {
        if (cancelled.has(params.sessionId)) return { stopReason: "cancelled" };
        await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
        await sleep(100);
      }
      return { stopReason: "end_turn" };
    }

    // Session-state updates: these must NOT become transcript rows.
    await notify({ sessionUpdate: "available_commands_update", availableCommands: [] });
    await notify({ sessionUpdate: "usage_update", used: 12_500, size: 200_000, cost: { amount: 0.42, currency: "USD" } });
    await notify({ sessionUpdate: "session_info_update", title: "Mock session" });

    await notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });

    for (const text of ["PROBE", "_", "OK"]) {
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
      await sleep(30);
    }

    // A tool call with several updates: the client must fold these into ONE row.
    await notify({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Terminal",
      kind: "execute",
      status: "pending",
      rawInput: { command: "git status --short" },
    });
    await notify({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "in_progress" });
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "git status --short",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });

    // Drive a real terminal through the client, including one that never exits.
    const quick = await client.request("terminal/create", {
      sessionId: params.sessionId,
      command: "sh",
      args: ["-c", "echo terminal-works"],
    });
    await client.request("terminal/wait_for_exit", { sessionId: params.sessionId, terminalId: quick.terminalId });
    const out = await client.request("terminal/output", { sessionId: params.sessionId, terminalId: quick.terminalId });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `[terminal: ${JSON.stringify(out.output.trim())} exit=${out.exitStatus?.exitCode}]` },
    });
    await client.request("terminal/release", { sessionId: params.sessionId, terminalId: quick.terminalId });

    // A command that spawns a child and never exits — the orphan case.
    const hung = await client.request("terminal/create", {
      sessionId: params.sessionId,
      command: "sh",
      args: ["-c", "sleep 9991 --kirochrome-orphan-probe & sleep 9992 --kirochrome-orphan-probe"],
    });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `[hung terminal: ${hung.terminalId}]` },
    });
    await sleep(300);
    await client.request("terminal/kill", { sessionId: params.sessionId, terminalId: hung.terminalId });
    const hungExit = await client.request("terminal/wait_for_exit", { sessionId: params.sessionId, terminalId: hung.terminalId });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `[killed: signal=${hungExit.signal}]` },
    });
    await client.request("terminal/release", { sessionId: params.sessionId, terminalId: hung.terminalId });

    // An edit carrying a real diff, so the client can render it as one.
    await notify({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit",
      kind: "edit",
      status: "in_progress",
      rawInput: { file_path: "src/greet.ts" },
    });
    await notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      title: "src/greet.ts",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "src/greet.ts",
          oldText: "export function greet(name) {\n  return \"hi \" + name;\n}\n",
          newText: "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
        },
      ],
    });

    // Blocks until the client answers.
    const decision = await client.request("session/request_permission", {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "tool-2", title: "Delete build artefacts?" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `[permission: ${JSON.stringify(decision.outcome)}]` },
    });

    await notify({ sessionUpdate: "usage_update", used: 18_900, size: 200_000, cost: { amount: 0.51, currency: "USD" } });
    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
await app.connect(stream).closed;
