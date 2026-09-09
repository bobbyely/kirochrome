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

## Where this is now

Phases 0–5 are built and running locally against Claude Code. What works: the
setup check ladder, streaming chat, persistence and resume, per-session working
directories, agent-advertised model and mode pickers, tool-call cards,
permission prompts, terminals with orphan-safe process handling, renaming, and
live per-conversation status.

What is left, in the order I would do it:

1. **Default model per provider**, remembered and re-applied after
   `session/new` — a remembered choice, never a hardcoded list.
2. **Group consecutive tool calls and thinking** into one collapsed work row.
3. **Archiving**, so the sidebar stays usable as conversations accumulate.
4. Search, theme control, keyboard shortcuts, image paste, export.

Every invariant in AGENTS.md is now enforced by code.

Still unanswered since phase 0: whether Kiro speaks `configOptions` or the
older `availableModels`. The code handles both, so nothing is blocked, but
running the spike on the work machine would let us delete a fallback path
instead of carrying it on speculation.

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

- [x] Working directory is chosen per session, not fixed at server launch.
      ACP sessions are workspace-scoped — `session/new` takes a `cwd`, and the
      agent loads that directory's project context (`CLAUDE.md`/`AGENTS.md`,
      git state). One global `cwd` means every conversation is stuck on
      whichever project the server was started from.
- [x] New-chat flow lists only providers whose check is `ok`
- [x] Sessions persist on open and are titled from the first message
- [x] Data-driven pickers, merging `configOptions` with the legacy
      `availableModels` / `modes` dialects
- [x] Session list sidebar; reopen calls `session/load`
- [x] Session titles (first message, or agent-provided)
- [x] Runtime failures mark the provider `stale` and link back to setup

**Done when:** two sessions on two different providers, both resumable after a
server restart.

### Verified

- A conversation survives a restart and `session/load` re-attaches an agent to
  it. **The agent's replay is discarded** — it re-sends its whole history as
  `session/update` before answering the load, and our log already holds it, so
  appending would duplicate the transcript. Confirmed: 0 duplicated rows.
- Per-session `cwd` is honoured, and previously used directories are offered.
- Both pickers drive the agent: mode and model switch live mid-session.

### Layout

Restructured to a persistent sidebar beside one main view: new chat and past
conversations on the left, Setup as a page you visit rather than the landing
screen.

### Two protocol findings

- **`session/set_model` is not in the SDK's v1 method registry**, though Kiro's
  docs still list it — model selection moved to `session/set_config_option`.
  So a config change tries the standard method and falls back to the per-kind
  one, rather than guessing the dialect from the `session/new` response.
- **Agents can emit both dialects at once**, and not with the same settings in
  each. `configOptions` and the legacy `models`/`modes` are merged rather than
  letting one hide the other — the mock exposed this by advertising a model in
  one and a mode in the other.

---

## Phase 5 — Tools and terminals

**Goal:** the desktop-app feel, and hanging processes handled properly.

- [x] Fold events into typed timeline rows (`timeline.ts`), replacing the
      phase-2 `toBubbles` stopgap
- [x] Render `ToolCall` / `ToolCallUpdate` as cards, collapsed by default and
      expandable — all updates for one call fold into a single row
- [x] File diffs rendered as diffs; read output syntax-highlighted
- [x] Permission requests → approve/deny buttons, plus an auto-approve toggle
- [x] Queue messages typed during a turn, sending them when it ends
- [x] Advertise `terminal: true`; implement `terminal/create`, `output`,
      `wait_for_exit`, `kill`, `release`
- [x] `TerminalRegistry`: wall-clock cap, `outputByteLimit`, process-group kill
      (SIGTERM → SIGKILL), ledger for orphan reaping at startup
- [x] `agent_exited` surfaced in the UI as a transcript row
- [x] Stop button → `session/cancel`

**Done when:** an infinite command (`sleep 99999`, `yes`) is killed cleanly by
the timeout, leaves no orphan in the process table, and the UI reports why.

### Verified so far

A turn emitting one `tool_call` plus two `tool_call_update`s produces **one**
row, not three: 15 raw events fold to 7 rows. The card's title upgrades from
`Terminal` to the command actually run, which arrives on a later update.

Permission requests block the agent until answered. The ACP request is held
open, so the agent waits exactly as long as the human does, and the prompt is
an ordinary log event — it survives a refresh mid-decision.

### Terminals verified

Measured directly rather than assumed:

- A shell spawning two background grandchildren, then killed: **2 processes
  while running, 0 after** — the process *group* died, not just the leader.
  That is the orphan bug the design called out, demonstrably handled.
- 50KB of output into a 200-byte limit keeps 200 bytes and sets `truncated`.
- stdout and stderr are both captured, with the exit status.
- **A command that cannot start no longer kills the server.** `spawn` emits
  `error`, not `exit`, and the unhandled event was fatal. Since the *agent*
  chooses these commands, a typo in a tool call could have taken down every
  session. Now reported as exit 127 with an explanation.

### Session titles come from the agent

`session_info_update` carries a title, so conversations name themselves and the
first-message fallback is only used when an agent sends none. No summarisation
call, no extra tokens.

---

## Phase 6 — Polish

- [ ] FTS5 search across all sessions
- [ ] `AGENT_NOT_FOUND` offers per-platform install commands and a manual path
      field, rather than only naming the paths tried
- [x] Context-window usage indicator (from `usage_update`)
- [x] Rename conversations; a manual name locks against the agent renaming it
- [x] Live status per conversation in the sidebar (working / needs input /
      ready / detached), pushed rather than polled
- [ ] Group consecutive tool calls and thinking into one collapsed work row
      ("Ran 3 tools"), expandable to the individual cards. This is Kirodex's
      `WorkGroupRow` pattern; `timeline.ts` already folds per call, so this is
      the next fold up.
- [ ] Remember a default model (and mode) per provider, applied to each new
      session. Store the chosen `configOption` values against the provider and
      re-apply after `session/new` — still never a hardcoded list, just a
      remembered choice.
- [ ] Archive conversations: hide them from the sidebar without deleting the
      log. `sessions.status` already has room for it; `events` stays untouched,
      since the log is append-only.
- [ ] Theme control on the Setup page: light / dark / follow system. Today the
      theme is `prefers-color-scheme` only, with no way to override it.
- [ ] Keyboard shortcuts, session switching
- [ ] Image paste (Kiro advertises `promptCapabilities.image`)
- [ ] Export a session to markdown

---

## Deliberately out of scope for now

- LAN / remote / tunnelled access, and therefore auth. Localhost only.
- Multi-user anything.
- Writing our own agent. We are a client.
- Windows as a first-class target — best-effort, fixed if it is cheap.
