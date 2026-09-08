# KiroChrome — Design

**Status:** proposed
**Last updated:** 2026-09-09

## Goal

A browser chat UI with the ergonomics of Claude Code / Codex desktop apps —
streaming output, real markdown and code rendering, tool-call and diff views,
and every past session searchable — driven by Kiro CLI and, ideally, any other
CLI coding agent.

## Constraints

1. **Kiro is only on a work machine.** Development happens on a personal Linux
   box without it. The app must be buildable and testable against a different
   agent, and switch to Kiro by configuration, not code.
2. **macOS and Linux first-class**, Windows best-effort.
3. **Localhost only** in v1. This process spawns things that execute commands.

## The key finding: ACP

There is an emerging standard for exactly this problem — the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), deliberately
"LSP, but for coding agents". **JSON-RPC 2.0 over stdio** to a subprocess.

**[Kiro CLI speaks it natively](https://kiro.dev/docs/cli/acp/):** `kiro-cli acp`.

This removes the largest risk in the project. We do not parse CLI output, strip
ANSI, or wrap a PTY. We speak a documented protocol and get structured
streaming, tool calls, permission requests and session loading for free.

It also answers "can this work with any agent?" — Gemini CLI is native, Claude
Code and Codex have adapters. Supporting a new agent is a config entry naming
a command, not a new parser.

```
 browser (React + Vite)
        │  WebSocket — our own small message set
        ▼
 server (Node + TypeScript)          ← implements the ACP *Client* role
   ├─ SessionManager ── Session ── SQLite (append-only events)
   │                       │
   │                       │  JSON-RPC 2.0 over stdio
   │                       ▼
   │                  agent subprocess  (`kiro-cli acp`)
   │
   └─ TerminalRegistry ── child processes the agent asked us to run
```

Note the server is the **ACP client**. Normally that role is played by an
editor; here it is played by a web server, and the browser is its front end.
That mapping is what makes tool-approval UX fall out of the protocol instead of
being invented.

## Key decision 1 — the event log is the source of truth

Every session is an **append-only log of typed events**. The server appends;
the browser is a pure renderer of the log plus a live tail.

Everything good falls out of this one choice: refresh mid-turn and lose
nothing, restart the server and resume, two tabs on one session, scrollback
search, replay for debugging. The alternative — holding authoritative state in
React — makes each of those a separate feature bolted on later, badly.

**Append-only is a discipline, not a file format.** We store it in SQLite.

## Key decision 2 — SQLite, built into Node

Node 22 ships `node:sqlite` with no flag and no native module, with FTS5
compiled in (verified on the dev machine). That removes the usual reason to
reach for flat files, and one store beats two stores that must be kept in sync.

```
Linux   $XDG_DATA_HOME/kirochrome/kirochrome.db  (~/.local/share/…)
macOS   ~/Library/Application Support/kirochrome/kirochrome.db
```

```sql
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,   -- ours
  agent_session_id TEXT,               -- the agent's, for session/load
  provider         TEXT NOT NULL,      -- 'kiro' | 'claude-code' | …
  cwd              TEXT NOT NULL,
  title            TEXT,
  status           TEXT NOT NULL,      -- 'draft' | 'active' | 'closed'
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- global order
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL   -- JSON: the ACP update or our own event
);
CREATE INDEX idx_events_session ON events(session_id, seq);
```

`events` is INSERT-only — never UPDATE, never DELETE. `sessions` is a derived
index that could be rebuilt by replaying `events`, which means a corrupt or
schema-changed index is a rebuild, not a migration.

`seq` is the resume mechanism: the browser reconnects saying "I have up to
412", the server runs one query for everything after. That is the whole of
reconnect.

**Do not write a row per token.** A turn emits thousands of
`AgentMessageChunk` deltas; buffer in memory and flush a coalesced row every
~250ms.

**Two stores exist, and that is fine.** The agent keeps its own conversation
state where we cannot see it; we persist its `sessionId` so `session/load` can
re-hydrate it. Ours is the UI's truth, the agent's is the model's.

## Key decision 3 — never hardcode providers or models

`session/new` returns the agent's available models and modes. Newer ACP
generalises this to `configOptions`: a list of `{id, name, category, type,
currentValue, options[]}` that the client renders as selectors, changeable at
any point in a session.

So the composer's pickers are **data-driven**. We render whatever the agent
advertises and send back `session/set_config_option` (falling back to
`session/set_model` / `session/set_mode` for agents on the older API, which is
what Kiro currently documents). One agent exposes models, another exposes
reasoning level — same UI code, no per-agent branching.

*Provider* is the exception: it is which binary to spawn, which is our config,
not the protocol's.

## Session lifecycle

```
new chat
  → pick provider           → spawn subprocess, `initialize`
                            → `session/new {cwd, mcpServers}`
                            → returns sessionId + config options
  → composer shows pickers  → `session/set_config_option` on change
  → first message sent      → session promoted draft → active, persisted
  → `session/prompt`        → stream session/update → append events → WS
  → later: reopen           → `session/load` re-hydrates the agent
```

**The wrinkle:** models are only known *after* `session/new`, so the picker
cannot be populated before a session exists. Hence **draft sessions** — picking
a provider creates one immediately so the pickers can populate; it is promoted
to `active` on first message, and drafts are garbage-collected on startup.

## Robustness: hanging processes

Because we advertise `terminal: true`, the agent delegates command execution to
us via `terminal/create` / `output` / `wait_for_exit` / `kill` / `release`.
Process lifecycle is therefore **our** responsibility. Four distinct hazards,
each needing its own answer:

| Hazard | Answer |
|---|---|
| A command the agent asked us to run never exits | `TerminalRegistry` tracks every terminal with a wall-clock cap; on expiry `kill`, capture final output, mark it timed-out. Independent of the agent's own timeout. |
| A command produces unbounded output | Honour `outputByteLimit`; truncate from the start at a character boundary and set `truncated`. Never buffer without a cap. |
| Killing a shell leaves orphaned children | Spawn POSIX children `detached: true` and kill the **process group** (`process.kill(-pid, …)`), SIGTERM then SIGKILL after a grace period. Windows uses `taskkill /T /F`. This is the classic bug and the reason "it hangs" survives a naive kill. |
| The agent subprocess wedges, crashes, or never answers | Timeout every JSON-RPC request. Surface `agent_exited` as an event so the UI shows a dead session instead of a spinner forever. Offer restart + `session/load`. |

Two more rules that matter:

- **A turn is owned by the server, not the socket.** If the browser
  disconnects mid-turn the turn keeps running and keeps appending; this is the
  main practical payoff of the event log.
- **Every child PID is recorded.** On startup, reap orphans from a previous
  server that died without cleaning up.
- Stop in the UI maps to `session/cancel`, and must remain responsive even
  when the agent is busy.

## Security

- Bind `127.0.0.1` explicitly, never `0.0.0.0`.
- **Check the WebSocket `Origin` header even on localhost** — any page in your
  browser can otherwise open a socket to a local server.
- `chmod 0600` the database; it will hold work conversations and source code.
- Never log environment variables when logging spawns.

## Portability

- `spawn` with an **args array**, never a shell string.
- **No native modules.** `node:sqlite` is built in; `node-pty` is not needed
  because ACP removed the PTY requirement entirely.
- Paths via `node:path`; data dir resolved per-OS.
- `node:sqlite` prints an `ExperimentalWarning` on Node 22 and is stable on 24.
  Pin via `.nvmrc`; `better-sqlite3` is a near drop-in escape hatch.

## Rejected alternatives

- **Parsing CLI output / PTY wrapping** — obsolete once ACP exists. Was the
  original plan; the research killed it.
- **JSONL files for the event log** — one store beats two. SQLite is free here.
- **SSE + POST instead of WebSocket** — traffic is genuinely bidirectional
  (interrupts, approvals, config changes mid-turn).
- **Python/FastAPI backend** — fine on merit, but a TS server shares event
  types with the React client and removes a class of drift bugs.
- **Browser talks to the CLI directly** — impossible; a page cannot spawn
  processes.
- **Electron wrapper** — the browser is the point.
