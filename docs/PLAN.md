# KiroChrome — Implementation Plan

Companion to [DESIGN.md](DESIGN.md). Each phase ends with something you can
actually use; no phase is pure scaffolding.

## Development agent

Kiro is on the work machine, so we develop against **Claude Code via the ACP
adapter** (`npx @zed-industries/claude-code-acp`), which is already installed on
the dev box. Because both speak ACP, "make it work with Kiro" is a config entry,
not a port. We develop against a real agent the whole way.

Phase 0 verifies that assumption before anything is built on it.

## Repo layout

```
kirochrome/
├── packages/
│   ├── shared/   types: WS messages, event payloads, error codes, config
│   ├── server/   ACP client, SessionManager, TerminalRegistry, store, WS
│   └── web/      React + Vite
└── docs/
```

npm workspaces. `shared` is imported by both sides so the wire format cannot
drift.

## Why setup comes before chat

The setup page is phase 0's spike with a UI on it — same handshake, same
diagnostics, just persisted and rendered. Building it first means every later
phase is debugged through a tool that already exists, and the error taxonomy is
established before there is code that needs to throw. Chatting against an agent
you have not verified is how you end up debugging a spinner.

---

## Phase 0 — Handshake spike

**Goal:** prove ACP works end to end before designing around it.

A throwaway script: spawn an agent, `initialize`, `session/new`, one prompt,
print every `session/update` raw.

- [x] `npm i --save-exact @agentclientprotocol/sdk` (1.4.0)
- [x] Spawn the Claude Code adapter, complete `initialize`
- [x] Dump `protocolVersion`, `agentCapabilities`, `authMethods`
- [x] `session/new`, dump config options / modes
- [x] One `session/prompt`, print the raw update stream
- [x] Mock ACP agent as an offline fixture
- [ ] Run the same script against `kiro-cli acp` **on the work machine**, diff

### Findings

- **ACP works as designed.** `initialize` against the real Claude Code adapter
  returned `protocolVersion: 1`, `loadSession: true`, prompt capabilities, and
  an `authMethods` entry — the whole basis of the check ladder, confirmed.
- **The SDK client API** is `client({name})` → `.onNotification("session/update")`
  / `.onRequest("session/request_permission")` → `connectWith(ndJsonStream(…))`.
  `buildSession(cwd).start()` wraps `session/new`.
- **The stderr buffer paid for itself immediately.** The adapter failed
  `session/new` with `-32603 "Query closed before response received"` — useless
  on its own. stderr held the real cause: it refuses to run nested inside
  another Claude Code session. Keep this diagnostic; it is not optional.
- **The package was renamed** to `@agentclientprotocol/claude-agent-acp`.
- **Both config shapes exist at once.** The mock returns `configOptions` *and* a
  legacy `modes` state, and the client read both — so phase 4's pickers must
  handle either, as designed.
- **Streaming shapes confirmed:** `agent_message_chunk`, `tool_call`,
  `tool_call_update`, terminating with `stopReason`.

**Open:** whether Kiro uses `configOptions` or the older `availableModels`.
Needs a run on the work machine. Not blocking — the design handles both.

**Risk retired:** every protocol assumption in DESIGN.md, except Kiro's exact
config-option dialect.

---

## Phase 1 — Setup page and error foundations

**Goal:** know that a configured agent works before ever opening a chat.

- [ ] Workspace setup, TS strict, `.nvmrc`
- [ ] `shared`: `KcError`, `KcErrorCode` enum, remediation map, WS message types
- [ ] Provider registry config (`{id, name, command, args, cwd?}`)
- [ ] Check ladder: `resolve → spawn → initialize → version → authenticate →
      session → capabilities`, each rung its own error code
- [ ] Per-session stderr ring buffer (~64KB), attached to error reports
- [ ] `KIROCHROME_TRACE=1` JSON-RPC frame trace
- [ ] `provider_checks` table; results persisted with timestamp
- [ ] Setup UI: provider list, per-provider status, stage reached, remediation,
      raw stderr behind a details toggle, "Re-check" button
- [ ] `authenticate` flow when the agent advertises `authMethods`
- [ ] Server on `127.0.0.1` with WebSocket `Origin` checking

**Done when:** a deliberately broken provider (bad path, wrong args, logged-out
agent) reports the *specific* rung it failed on with actionable text — and a
good one shows its capabilities and model list.

---

## Phase 2 — Walking skeleton

**Goal:** type a prompt in a browser, watch tokens stream in.

- [ ] ACP client wrapper reused from the check ladder
- [ ] One session against a verified provider
- [ ] Message list + composer
- [ ] Text deltas render as they arrive
- [ ] RPC timeouts wired to the error types from phase 1

**Done when:** prompt in, streaming text out. No persistence, no markdown, one
session, ugly. End to end is the point.

---

## Phase 3 — Persistence and resume

**Goal:** never lose a conversation.

- [ ] SQLite store, schema from DESIGN.md, `chmod 0600`
- [ ] Append events; coalesce text deltas on a ~250ms flush
- [ ] Resume by `seq`: browser sends its high-water mark on connect
- [ ] Turns survive browser disconnect (server-owned, not socket-owned)
- [ ] Error events persisted inline in the transcript
- [ ] Markdown + syntax highlighting

**Done when:** refresh mid-turn and lose nothing; restart the server and the
conversation is still there.

---

## Phase 4 — Providers, models, sessions

**Goal:** the full flow — new chat → provider → model → persisted session.

- [ ] New-chat flow lists only providers whose check is `ok`
- [ ] Draft sessions: spawn + `session/new` on provider select, promote to
      `active` on first message, GC drafts at startup
- [ ] Data-driven pickers from `configOptions`, falling back to
      `session/set_model` / `set_mode`
- [ ] Session list sidebar; reopen calls `session/load`
- [ ] Session titles (first message, or agent-provided)
- [ ] Runtime failures mark the provider `stale` and link back to setup

**Done when:** two sessions on two different providers, both resumable after a
server restart.

---

## Phase 5 — Tools and terminals

**Goal:** the desktop-app feel, and hanging processes handled properly.

- [ ] Render `ToolCall` / `ToolCallUpdate` as cards, not text blobs
- [ ] File diffs rendered as diffs
- [ ] Permission requests → approve/deny buttons
- [ ] Advertise `terminal: true`; implement `terminal/create`, `output`,
      `wait_for_exit`, `kill`, `release`
- [ ] `TerminalRegistry`: wall-clock cap, `outputByteLimit`, process-group kill
      (SIGTERM → SIGKILL), PID file for orphan reaping at startup
- [ ] `agent_exited` surfaced in the UI; restart offered
- [ ] Stop button → `session/cancel`

**Done when:** an infinite command (`sleep 99999`, `yes`) is killed cleanly by
the timeout, leaves no orphan in the process table, and the UI reports why.

---

## Phase 6 — Polish

- [ ] FTS5 search across all sessions
- [ ] Keyboard shortcuts, session switching
- [ ] Image paste (Kiro advertises `promptCapabilities.image`)
- [ ] Export a session to markdown

---

## Deliberately out of scope for now

- LAN / remote / tunnelled access, and therefore auth. Localhost only.
- Multi-user anything.
- Writing our own agent. We are a client.
- Windows as a first-class target — best-effort, fixed if it is cheap.
