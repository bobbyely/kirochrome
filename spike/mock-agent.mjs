// A minimal ACP agent, used to exercise our client without needing a real one.
// Kept because it is the obvious test fixture for phase 1: deterministic,
// offline, and able to fake failures on demand.

import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

const cancelled = new Set();
/** Set from the client's `initialize`; gates the compaction updates below. */
let compactionAllowed = false;

const app = agent({ name: "mock-agent" })
  // ACP sends cancellation as a notification, not a request.
  .onNotification("session/cancel", ({ params }) => {
    cancelled.add(params.sessionId);
  })
  .onRequest("initialize", ({ params }) => {
    // Agents MUST NOT send compaction updates unless the client asked for
    // them. Recording it here lets a test prove we advertise what we render.
    compactionAllowed = params?.clientCapabilities?.session?.compaction != null;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: process.env.MOCK_NO_LOAD_SESSION ? false : true,
        promptCapabilities: { image: true, embeddedContext: true },
        // ACP nests these inside agentCapabilities, and each sub-capability is
        // an object: `{}` means supported. An agent that keeps no history of
        // its own omits `list`, which MOCK_NO_SESSION_LIST simulates.
        sessionCapabilities: process.env.MOCK_NO_SESSION_LIST ? {} : { list: {} },
      },
      agentInfo: { name: "mock-agent", title: "Mock Agent", version: "0.0.0" },
      authMethods: [],
    };
  })
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
  // Conversations "started in the CLI", paginated over two pages so the
  // client's cursor loop is exercised rather than assumed. One entry is
  // deliberately malformed: ACP says invalid items are skipped, not fatal.
  .onRequest("session/list", { parse: (p) => p }, async ({ params }) => {
    if (process.env.MOCK_HANG_SESSION_LIST) await new Promise(() => {});
    if (params?.cursor === "page-2") {
      return {
        sessions: [
          { sessionId: "cli-3", cwd: "/tmp/three", title: "Third", updatedAt: "2026-01-03T00:00:00Z" },
        ],
      };
    }
    return {
      sessions: [
        { sessionId: "cli-1", cwd: "/tmp/one", title: "First", updatedAt: "2026-01-01T00:00:00Z" },
        { cwd: "/tmp/nameless" }, // no sessionId: must be skipped
        { sessionId: "cli-2", cwd: "/tmp/two" }, // title and updatedAt are optional
      ],
      nextCursor: "page-2",
    };
  })
  // Replays history the way a real agent does, so the client's replay
  // suppression can be tested.
  // The Kiro autocomplete extension, so the client's option path is exercised.
  .onRequest("_kiro.dev/commands/options", { parse: (p) => p }, ({ params }) => {
    const values = { effort: ["low", "medium", "high", "xhigh", "max"] };
    const all = values[params.command] ?? [];
    return {
      options: all
        .filter((v) => v.startsWith(params.partial ?? ""))
        .map((v) => ({ value: v, label: v.toUpperCase(), current: v === "medium" })),
    };
  })
  .onRequest("session/set_config_option", ({ params }) => ({
    configOptions: [{ id: params.configId, currentValue: params.value }],
  }))
  .onRequest("session/set_mode", () => ({}))
  .onRequest("session/load", async ({ params, client }) => {
    const notify = (update) =>
      client.notify("session/update", { sessionId: params.sessionId, update });
    // Real agents replay both sides of the conversation, so the client has to
    // cope with a user_message_chunk as well as an agent one.
    await notify({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "WHAT I ASKED" },
    });
    for (const text of ["OLD ", "HISTORY"]) {
      await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    }
    // Real agents return these on load as well as on new.
    return {
      modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }, { id: "ask", name: "Ask" }] },
      configOptions: [
        {
          id: "model", name: "Model", category: "model", type: "select",
          currentValue: "mock-large",
          options: [{ value: "mock-large", name: "Mock Large" }, { value: "mock-small", name: "Mock Small" }],
        },
      ],
    };
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

    // A terminal the agent never releases, followed by a crash. Nothing
    // references that process group afterwards, so if the client does not
    // release it on the way out, it survives the session and the server both.
    // The command records its own pid, since only the client knows it.
    if (params.prompt?.[0]?.text === "leak-then-die") {
      const dir = process.env.KIROCHROME_DATA_DIR ?? "/tmp";
      await client.request("terminal/create", {
        sessionId: params.sessionId,
        command: "sh",
        args: ["-c", `echo $$ > "${dir}/leak.pid"; sleep 9993`],
      });
      // After the turn completes, so this is a crash and not a verdict on the
      // provider — see the exit-reason gotcha.
      setTimeout(() => process.exit(1), 100);
      return { stopReason: "end_turn" };
    }

    // Context compaction, which the client only sees if it advertised support.
    if (params.prompt?.[0]?.text === "compact") {
      if (!compactionAllowed) {
        await notify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "[compaction: not advertised]" },
        });
        return { stopReason: "end_turn" };
      }
      await notify({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" });
      for (const text of ["Earlier we ", "set up CI."]) {
        await notify({
          sessionUpdate: "compaction_summary_chunk",
          compactionId: "c1",
          content: { type: "text", text },
        });
      }
      // No `summary` field: omission means "leave it alone", so the chunks
      // above must survive this update rather than being cleared by it.
      await notify({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });

      // A second, failed compaction — the error is only valid with `failed`.
      await notify({ sessionUpdate: "compaction_update", compactionId: "c2", status: "in_progress" });
      await notify({
        sessionUpdate: "compaction_update",
        compactionId: "c2",
        status: "failed",
        error: "The model refused to summarise.",
      });
      return { stopReason: "end_turn" };
    }

    // A structured question. Kept behind its own keyword so the main turn's
    // event count stays stable for the tests that assert on it.
    if (params.prompt?.[0]?.text === "elicit") {
      const answer = await client.request("elicitation/create", {
        mode: "form",
        sessionId: params.sessionId,
        message: "Which release should I cut?",
        requestedSchema: {
          type: "object",
          title: "Release options",
          properties: {
            // Every field kind the client claims to render, including both
            // enum dialects: titled (oneOf/anyOf) and untitled (enum).
            channel: {
              type: "string",
              title: "Channel",
              oneOf: [
                { const: "stable", title: "Stable" },
                { const: "beta", title: "Beta", description: "Ships to testers" },
              ],
            },
            notes: { type: "string", title: "Release notes", maxLength: 200 },
            bump: { type: "integer", title: "Version bump", minimum: 0, maximum: 3 },
            sign: { type: "boolean", title: "Sign the tag", default: true },
            targets: {
              type: "array",
              title: "Targets",
              items: { type: "string", enum: ["linux", "macos", "windows"] },
            },
            // Not a type we render, and not required — must be dropped rather
            // than failing the whole form.
            weird: { type: "_vendor.thing", title: "Vendor extension" },
          },
          required: ["channel"],
        },
      });
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `[elicitation: ${JSON.stringify(answer)}]` },
      });
      return { stopReason: "end_turn" };
    }

    // A mode we never advertised. The client must decline it, not hang.
    if (params.prompt?.[0]?.text === "elicit-url") {
      const answer = await client.request("elicitation/create", {
        mode: "url",
        sessionId: params.sessionId,
        elicitationId: "elicit-url-1",
        url: "https://example.com/authorise",
        message: "Authorise in your browser",
      });
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `[elicitation: ${JSON.stringify(answer)}]` },
      });
      return { stopReason: "end_turn" };
    }

    // A required field we cannot render: the whole form must be declined.
    if (params.prompt?.[0]?.text === "elicit-unrenderable") {
      const answer = await client.request("elicitation/create", {
        mode: "form",
        sessionId: params.sessionId,
        message: "Pick a colour",
        requestedSchema: {
          type: "object",
          properties: { colour: { type: "_vendor.colour", title: "Colour" } },
          required: ["colour"],
        },
      });
      await notify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `[elicitation: ${JSON.stringify(answer)}]` },
      });
      return { stopReason: "end_turn" };
    }

    // Session-state updates: these must NOT become transcript rows.
    await notify({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "effort", description: "Set reasoning effort", input: { hint: "low|medium|high|xhigh|max" } },
        { name: "compact", description: "Compact the conversation" },
        { name: "model", description: "Change the model", input: { hint: "model id" } },
      ],
    });
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
