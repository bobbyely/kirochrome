// The socket as a view: one conversation at a time, over a connection that
// outlives switching between them.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "..", "..", "..", "spike", "mock-agent.mjs");
const provider = { id: "mock", name: "Mock", command: process.execPath, args: [MOCK] };

let dir, store, sessions, server, port;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-ws-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers: [provider] }));
  const { Store } = await import("../dist/store.js");
  const { SessionManager } = await import("../dist/sessionManager.js");
  const { attachWebSocket } = await import("../dist/ws.js");

  store = new Store(join(dir, "test.db"));
  sessions = new SessionManager(store);
  server = createServer();
  attachWebSocket(server, sessions, () => true);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(async () => {
  sessions?.closeAll();
  await new Promise((resolve) => server?.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** A connected client that records every frame the server sends. */
async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    /** Frames settle a tick after the turn resolves, so give them one. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 50)),
  };
}

describe("a socket", () => {
  it("stops receiving a conversation's events once it subscribes to another", async () => {
    const background = await sessions.open(provider, "/tmp");
    const foreground = await sessions.open(provider, "/tmp");
    const c = await client();
    // The mock asks permission, and nobody is watching the background session
    // through the socket, so answer it here or its turn never ends.
    const off = background.subscribe((events) => {
      for (const e of events) {
        if (e.type === "permission_request") {
          background.resolvePermission(e.requestId, e.options[0]?.optionId ?? null);
        }
      }
    });

    // A failed assertion must not leave an agent alive: node --test would then
    // hang on a live event loop instead of reporting the failure and exiting.
    try {
      c.send({ type: "subscribe", sessionId: background.id, sinceSeq: 0 });
      await c.settle();
      c.send({ type: "subscribe", sessionId: foreground.id, sinceSeq: 0 });
      await c.settle();

      const before = c.frames.length;
      await background.prompt("this must not reach the socket");
      await c.settle();

      const leaked = c.frames
        .slice(before)
        .filter((f) => f.type === "events" && f.sessionId === background.id);
      assert.deepEqual(leaked, [], "a background turn must not stream into the watched conversation");
    } finally {
      off();
      c.close();
      background.close();
      foreground.close();
    }
  });

  it("serves a second conversation's backlog over the same connection", async () => {
    const first = await sessions.open(provider, "/tmp");
    const second = await sessions.open(provider, "/tmp");
    const c = await client();

    try {
      c.send({ type: "subscribe", sessionId: first.id, sinceSeq: 0 });
      await c.settle();
      c.send({ type: "subscribe", sessionId: second.id, sinceSeq: 0 });
      await c.settle();

      const states = c.frames.filter((f) => f.type === "session_state").map((f) => f.session.id);
      assert.ok(states.includes(first.id), "the first subscribe must report its session");
      assert.equal(states.at(-1), second.id, "the switch must be served without a new socket");
    } finally {
      c.close();
      first.close();
      second.close();
    }
  });
});
