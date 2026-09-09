// Phase 0 spike: prove ACP works end to end, and capture what each agent
// actually advertises. Throwaway — its findings feed the phase 1 check ladder.
//
//   node handshake.mjs claude-code
//   node handshake.mjs kiro           # on the work machine

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const PROVIDERS = {
  // Offline fixture — no network, no auth, deterministic.
  mock: { command: process.execPath, args: [new URL("mock-agent.mjs", import.meta.url).pathname] },
  // NOTE: the adapter refuses to start inside an existing Claude Code session
  // (it shares runtime resources and can crash both). Run this one from a
  // plain terminal, not from within Claude Code.
  "claude-code": { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
  kiro: { command: "kiro-cli", args: ["acp"] },
};

const id = process.argv[2] ?? "claude-code";
const provider = PROVIDERS[id];
if (!provider) {
  console.error(`unknown provider '${id}'. known: ${Object.keys(PROVIDERS).join(", ")}`);
  process.exit(1);
}

const dump = (label, value) =>
  console.log(`\n===== ${label} =====\n${JSON.stringify(value, null, 2)}`);

// The agent's stdout is the JSON-RPC channel; everything human-readable —
// including crashes — goes to stderr. Keep it, it is the whole debugging story.
let stderrTail = "";
const keepStderr = (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-64_000);
};

console.log(`spawning: ${provider.command} ${provider.args.join(" ")}`);
const child = spawn(provider.command, provider.args, {
  stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32", // own process group, so we can kill the tree
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", keepStderr);
child.on("error", (err) => {
  console.error(`\n!! spawn failed: ${err.message}`);
  process.exit(1);
});

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

const app = client({ name: "kirochrome-spike" })
  // Log every streamed update raw. Seeing the real shapes is the point of this.
  .onNotification("session/update", ({ params }) => {
    const kind = params?.update?.sessionUpdate ?? "?";
    console.log(`[update] ${kind}: ${JSON.stringify(params.update)}`);
  })
  // The agent may ask permission mid-turn; auto-approve the first option so the
  // spike can complete a turn unattended.
  .onRequest("session/request_permission", ({ params }) => {
    const chosen = params.options?.[0];
    console.log(`[permission] auto-allowing: ${chosen?.name ?? "?"}`);
    return { outcome: { outcome: "selected", optionId: chosen?.optionId } };
  });

const killTree = () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else process.kill(-child.pid, "SIGTERM"); // negative pid = the whole group
  } catch {
    /* already gone */
  }
};

try {
  await app.connectWith(stream, async (agent) => {
    // --- rung 3+4: initialize and version ---
    const init = await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "kirochrome-spike", version: "0.0.0" },
    });
    dump("initialize response", init);
    console.log(`\nwe sent protocolVersion=${PROTOCOL_VERSION}, agent replied ${init.protocolVersion}`);
    console.log(`authMethods: ${JSON.stringify(init.authMethods ?? [])}`);

    // --- rung 6+7: session/new, and what config it exposes ---
    const session = await agent.buildSession(process.cwd()).start();
    dump("session/new response", session.newSessionResponse);

    const r = session.newSessionResponse;
    console.log("\n--- what the composer pickers would render ---");
    const options = Array.isArray(r.configOptions) ? r.configOptions : [];
    if (options.length === 0) console.log("  (no configOptions advertised)");
    for (const o of options) {
      console.log(`  id=${o.id}  category=${o.category ?? "-"}  type=${o.type}  current=${JSON.stringify(o.currentValue)}`);
      for (const v of o.options ?? []) console.log(`      ${JSON.stringify(v.value)}  ${v.name ?? ""}`);
    }
    console.log("\n  legacy models:", JSON.stringify(r.models ?? r.availableModels ?? null));
    console.log("  legacy modes :", JSON.stringify(session.modes ?? null));

    // --- a real turn ---
    console.log("\n--- prompting ---");
    const res = await session.prompt("Reply with exactly: PROBE_OK");
    dump("prompt response", res);
  });
  console.log("\n✅ handshake completed");
} catch (err) {
  console.error(`\n❌ failed: ${err?.message ?? err}`);
  if (err?.code !== undefined) console.error(`   json-rpc code: ${err.code}`);
  if (err?.data !== undefined) console.error(`   data: ${JSON.stringify(err.data)}`);
  if (stderrTail.trim()) console.error(`\n--- agent stderr (tail) ---\n${stderrTail.trim()}`);
  process.exitCode = 1;
} finally {
  killTree();
}
