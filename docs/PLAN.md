# KiroChrome — Implementation Plan

Companion to [DESIGN.md](DESIGN.md). Each phase ends with something you can
actually use; no phase is pure scaffolding.

## Development agent

Kiro is on the work machine, so we develop against **Claude Code via the ACP
adapter** (`npx @zed-industries/claude-code-acp`), which is already installed
on the dev box. Because both speak ACP, "make it work with Kiro" is a config
entry, not a port. This is much better than the fake-backend plan: we develop
against a real agent the whole way.

Phase 0 verifies that assumption before anything is built on it.

## Repo layout

```
kirochrome/
├── packages/
│   ├── shared/   types: our WS messages, event payloads, config
│   ├── server/   ACP client, SessionManager, TerminalRegistry, store, WS
│   └── web/      React + Vite
└── docs/
```

npm workspaces. `shared` is imported by both sides so the wire format cannot
drift.

---

## Phase 0 — Handshake spike

**Goal:** prove ACP works end to end before designing around it.

A throwaway script that spawns an agent, calls `initialize` and `session/new`,
sends one prompt, and prints every `session/update` raw.

- [ ] `npm i @agentclientprotocol/sdk` (pin exact version)
- [ ] Spawn `claude-code-acp`, complete `initialize`
- [ ] Dump advertised agent capabilities and config options
- [ ] `session/prompt` and print the raw update stream
- [ ] Run the same script against `kiro-cli acp` **on the work machine** and
      diff the capabilities

**Done when:** we have real captured output from both agents, and know whether
Kiro uses `configOptions` or the older `availableModels` API.

**Risk this retires:** every assumption in DESIGN.md about the protocol.

---

## Phase 1 — Walking skeleton

**Goal:** type a prompt in a browser, watch tokens stream in.

- [ ] Workspace setup, TS strict, `.nvmrc`
- [ ] `shared`: WS message types
- [ ] `server`: ACP client wrapper, one hardcoded session, WS endpoint on
      `127.0.0.1` with Origin checking
- [ ] `web`: Vite + React, message list, composer
- [ ] Text deltas render as they arrive

**Done when:** prompt in, streaming text out. No persistence, no markdown, one
session, ugly. End to end is the point.

---

## Phase 2 — Persistence and resume

**Goal:** never lose a conversation.

- [ ] SQLite store, schema from DESIGN.md, `chmod 0600`
- [ ] Append events; coalesce text deltas on a ~250ms flush
- [ ] Resume by `seq`: browser sends its high-water mark on connect
- [ ] Turns survive browser disconnect (server-owned, not socket-owned)
- [ ] Markdown + syntax highlighting

**Done when:** refresh mid-turn and lose nothing; restart the server and the
conversation is still there.

---

## Phase 3 — Providers, models, sessions

**Goal:** the flow — new chat → provider → model → persisted session.

- [ ] Provider registry in config (`{id, command, args}`)
- [ ] Draft sessions: spawn + `session/new` on provider select, promote to
      `active` on first message, GC drafts at startup
- [ ] Data-driven pickers from `configOptions`, with fallback to
      `session/set_model` / `set_mode`
- [ ] Session list sidebar; reopen calls `session/load`
- [ ] Session titles (first message, or agent-provided)

**Done when:** two sessions on two different providers, both resumable after a
restart.

---

## Phase 4 — Tools and terminals

**Goal:** the desktop-app feel, and hanging processes handled properly.

- [ ] Render `ToolCall` / `ToolCallUpdate` as cards, not text blobs
- [ ] File diffs rendered as diffs
- [ ] Permission requests → approve/deny buttons
- [ ] Advertise `terminal: true`; implement `terminal/create`, `output`,
      `wait_for_exit`, `kill`, `release`
- [ ] `TerminalRegistry`: wall-clock cap, `outputByteLimit`, process-group
      kill (SIGTERM → SIGKILL), PID file for orphan reaping at startup
- [ ] `agent_exited` surfaced in the UI; restart offered
- [ ] Stop button → `session/cancel`

**Done when:** an infinite command (`sleep 99999`, `yes`) is killed cleanly by
the timeout, leaves no orphan, and the UI reports it — verified by checking
the process table afterwards.

---

## Phase 5 — Polish

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
