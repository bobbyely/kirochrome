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

- [x] Workspace setup (npm workspaces, TS strict), `.nvmrc`
- [x] `shared`: `KcError`, `KcErrorCode` enum, `CHECK_STAGES`, remediation map
- [x] Provider registry config (`{id, name, command, args, cwd?}`), seeded on
      first run at `<dataDir>/config.json`
- [x] Check ladder: `resolve → spawn → initialize → version → authenticate →
      session → capabilities`, each rung its own error code
- [x] Per-session stderr ring buffer (64KB), attached to error reports
- [x] `KIROCHROME_TRACE=1` JSON-RPC frame trace
- [x] `provider_checks` table (`node:sqlite`), results persisted with timestamp
- [x] Setup UI: provider list, rung-by-rung ladder, remediation, raw stderr
      behind a details toggle, "Re-check" button
- [x] `authenticate` rung, including mapping a `-32000` at `session/new` back to
      the `authenticate` rung so the user is told what to act on
- [x] Server on `127.0.0.1` with `Origin` checking
- [x] Process-group kill, verified to leave no orphans

**Done when:** a deliberately broken provider (bad path, wrong args, logged-out
agent) reports the *specific* rung it failed on with actionable text — and a
good one shows its capabilities and model list.

### Verified

| Provider | Result |
|---|---|
| mock agent | `ok` — all seven rungs, config options and modes returned |
| missing binary | `failed` at `resolve` → `AGENT_NOT_FOUND`, lists paths tried |
| non-ACP process | `failed` at `initialize` → `AGENT_HANDSHAKE_TIMEOUT` |

Cross-site `Origin` rejected with 403; the Vite dev origin allowed. Check
results survive a server restart. No orphaned processes after a killed check.

### Deviation from the original phase list

Setup uses **HTTP JSON endpoints, not a WebSocket**. A check is request/response
— there is nothing to stream yet — so a socket would be complexity without
benefit. `Origin` checking is implemented now and the WebSocket arrives in phase
2 where streaming actually exists, reusing the same origin allowlist.

### Known rough edge

A non-ACP process only fails after the full 60s handshake timeout, which is a
long stare at a spinner. The timeout is generous because `npx` may download an
adapter on first run. Worth a per-provider override, or streaming rung progress
to the UI once the WebSocket lands in phase 2.

---

## Phase 2 — Walking skeleton

**Goal:** type a prompt in a browser, watch tokens stream in.

- [x] ACP client wrapper reused from the check ladder (`agentProcess.ts`)
- [x] One session against a verified provider
- [x] Message list + composer
- [x] Text deltas render as they arrive
- [x] RPC timeouts wired to the error types from phase 1
- [x] WebSocket transport with the same `Origin` allowlist as HTTP
- [x] Sessions torn down on SIGINT/SIGTERM, so no agents are orphaned

**Done when:** prompt in, streaming text out. No persistence, no markdown, one
session, ugly. End to end is the point.

### Built on the event log from the start

The phase list said "no persistence", and there is none — but the in-memory log
is already the append-only, `seq`-numbered shape from DESIGN.md rather than ad
hoc React state. `Session` owns the log and turns; the socket is only a view.
Phase 3 becomes "write this to SQLite" instead of a rewrite, and invariant 3
(the browser holds no authoritative state) holds from day one.

### Verified

- Streaming: `user_message → turn_start → agent_text → agent_update ×2 → turn_end`
- **Delta coalescing works.** The mock emits `"PROBE"`, `"_"`, `"OK"` as three
  chunks; they arrive as *one* `agent_text` event.
- **Replay works.** A second socket subscribing from `seq 0` reproduces the full
  transcript — the page-refresh case.
- Cross-site WebSocket upgrade rejected with 403; the Vite origin allowed.
- Path traversal (`/../../etc/passwd`) falls back to the SPA, not the file.
- No orphaned agents after shutdown.

### Not verified

**The UI has not been opened in a browser.** It builds and typechecks, but there
is no browser on the dev box, so layout and styling are unconfirmed.

### New dependency

`ws@8.18.0` — Node has no built-in WebSocket *server*. No native build.

---

## Phase 3 — Persistence and resume

**Goal:** never lose a conversation.

- [x] SQLite store, schema from DESIGN.md, `chmod 0600`
- [x] Append events; coalesce text deltas on a ~250ms flush
- [x] Resume by `seq`: browser sends its high-water mark on connect
- [x] Turns survive browser disconnect (server-owned, not socket-owned)
- [x] Error events persisted inline in the transcript
- [x] Markdown + syntax highlighting
- [x] Recent-chats list, so a persisted conversation can be reopened

**Done when:** refresh mid-turn and lose nothing; restart the server and the
conversation is still there.

### Verified

Created a session, killed the server, restarted it: the conversation was listed
with its derived title, all 11 events replayed from disk, and the database was
`0600`. Prompting a restored session is refused with `SESSION_NOT_LIVE` rather
than failing obscurely.

### Schema deviation

`events` uses a composite `(session_id, seq)` primary key rather than DESIGN.md's
global `AUTOINCREMENT` rowid. `seq` is per-session and is what the wire protocol
resumes from, so making it the key avoids translating between two orderings.
DESIGN.md updated to match.

### Restored sessions are read-only

Re-attaching an agent needs `session/load`, which is phase 4. Until then a
restored conversation shows its transcript and says so plainly.

### New dependencies

`react-markdown`, `remark-gfm`, `rehype-highlight`, `highlight.js`.
`react-markdown` builds React elements rather than setting innerHTML, so model
output cannot inject script — chosen for that over a smaller renderer plus a
sanitiser. It costs ~150KB gzipped, which is accepted: this is served from
localhost.

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

- [ ] Fold events into typed timeline rows (see Kirodex's row taxonomy in
      AGENTS.md), replacing the phase-2 `toBubbles` stopgap
- [ ] Render `ToolCall` / `ToolCallUpdate` as cards, collapsed by default and
      expandable — an always-expanded transcript is unreadable
- [ ] File diffs rendered as diffs; read output syntax-highlighted
- [ ] Permission requests → approve/deny buttons, plus an auto-approve toggle
- [ ] Queue messages typed during a turn, sending them when it ends
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
- [ ] `AGENT_NOT_FOUND` offers per-platform install commands and a manual path
      field, rather than only naming the paths tried
- [ ] Context-window usage indicator
- [ ] Keyboard shortcuts, session switching
- [ ] Image paste (Kiro advertises `promptCapabilities.image`)
- [ ] Export a session to markdown

---

## Deliberately out of scope for now

- LAN / remote / tunnelled access, and therefore auth. Localhost only.
- Multi-user anything.
- Writing our own agent. We are a client.
- Windows as a first-class target — best-effort, fixed if it is cheap.
