# KiroChrome — Design

**Status:** implemented, and amended where reality disagreed
**Last updated:** 2026-09-10

This is the *why*. It has been amended in place where building it proved a
detail wrong — the `events` primary key is the clearest case. Protocol facts
learned since have moved to [PROTOCOL.md](PROTOCOL.md); the rules that came out
of all this are in [AGENTS.md](../AGENTS.md).

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

-- seq is per-session, not global: it is what the wire protocol resumes from,
-- so it is the key rather than a rowid we would have to translate.
CREATE TABLE events (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL   -- JSON: the ACP update or our own event
  , PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
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

Only providers that passed their setup check (below) are offered.

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

**The other way in: adoption.** Where an agent keeps conversations of its own,
`session/list` offers them and choosing one calls `session/load` against a
freshly minted KiroChrome conversation. Listing is an HTTP endpoint rather than
a socket message because it happens before any conversation exists — there is
nothing to stream, and it needs its own short-lived probe agent, which is
exactly the shape of the check ladder. Adopting *is* a socket message, because
it produces a live session and those belong to `SessionManager`.

This is the one place `session/load`'s replay is appended rather than
discarded: our log is empty, so the replay is the transcript. An `adopted`
event marks the seam, and every later reopen is an ordinary resume, so the
history is captured exactly once. See
[PROTOCOL.md](PROTOCOL.md#an-adopted-conversation-is-the-one-case-where-the-replay-is-kept).

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
- **Every child PID is recorded**, agents included, in a ledger under the data
  directory. On startup — *once*, before anything spawns — process groups left
  by a previous server are killed. Doing this per-session would kill processes
  belonging to sessions that are still alive.
- **PIDs are recycled by the OS**, so a stale ledger entry could name an
  unrelated process. Every entry is verified against the live process's command
  line before anything is killed.

What each kind of shutdown guarantees:

| How the server ends | Agents | Commands the agent started itself |
|---|---|---|
| Ctrl-C / SIGTERM | killed, as a group | killed with the group |
| `kill -9` | exit on stdin EOF, if well-behaved | **leak** — nothing can run at that moment |
| next startup | — | reaped from the ledger |
- Stop in the UI maps to `session/cancel`, and must remain responsive even
  when the agent is busy.

## Setup and preflight checks

Failures must surface on a **setup page**, not as a mysterious hang inside a
chat. Configuration is verified up front; once a provider passes, the chat flow
trusts it and does not re-diagnose.

### The check ladder

A provider check is a **staged probe that reports which rung it fell off**, not
a boolean. Each stage has its own error code and its own remediation:

| # | Stage | Verifies | Failure code |
|---|---|---|---|
| 1 | `resolve` | binary exists at the configured path or on `PATH` | `AGENT_NOT_FOUND` |
| 2 | `spawn` | the process actually starts | `AGENT_SPAWN_FAILED` |
| 3 | `initialize` | handshake completes within a timeout | `AGENT_HANDSHAKE_TIMEOUT` |
| 4 | `version` | agent's `protocolVersion` is one we support | `AGENT_PROTOCOL_MISMATCH` |
| 5 | `authenticate` | `authMethods` satisfied, if the agent requires it | `AGENT_AUTH_REQUIRED` |
| 6 | `session` | `session/new` succeeds | `AGENT_SESSION_FAILED` |
| 7 | `capabilities` | record `loadSession`, prompt capabilities, config options | — |

Then tear the probe session down. Stage 6 is what makes "assume the draft will
work" safe — it exercises the exact call the draft flow depends on, and returns
the model list as a side effect, so the setup page can show *which* models a
provider offers.

Stage 5 matters more than it looks: agents advertise `authMethods` in the
`initialize` response and return JSON-RPC error **`-32000` (auth required)** if
the client never calls `authenticate`. Skipping that step is a known way to
break ACP clients against agents that require login. Catching it at setup turns
"the chat silently does nothing" into "click Authenticate".

### Persisting results

```sql
CREATE TABLE provider_checks (
  provider_id TEXT PRIMARY KEY,
  status      TEXT NOT NULL,   -- 'ok' | 'failed' | 'stale'
  stage       TEXT,            -- rung reached
  error_code  TEXT,
  detail      TEXT,            -- JSON: capabilities, models, stderr tail
  checked_at  INTEGER NOT NULL
);
```

A provider must be `ok` before it appears in the new-chat provider list. If a
runtime failure happens anyway — the binary was removed, a token expired — the
provider is marked `stale` and the error links back to the setup page. Verified
is a cached fact with a timestamp, not a permanent guarantee.

First run with nothing configured lands on setup.

## Errors and debugging

The dominant failure mode of a project like this is an opaque hang. The design
treats diagnosability as a feature, not an afterthought.

### Typed errors, never strings

```ts
type KcError = {
  code: KcErrorCode      // closed enum in packages/shared
  stage?: CheckStage     // where in the ladder, if applicable
  message: string        // what happened
  remediation?: string   // what the user should do about it
  detail?: unknown       // structured context
  cause?: string         // underlying error, preserved
}
```

Every code maps to a remediation string. `AGENT_NOT_FOUND` says which path was
tried and notes that GUI apps often do not inherit shell `PATH` — the exact
caveat [Kiro's own docs call out](https://kiro.dev/docs/cli/acp/).

### Errors are events

Failures are appended to the event log like any other event. They persist, they
appear inline in the transcript where they happened, and they are still there
after a restart. This follows from the log being the source of truth: an error
the UI renders but never records is an error you cannot debug tomorrow.

### Capture the agent's stderr

**This is the single highest-value debugging lever.** The agent's stdout is the
JSON-RPC channel and carries nothing human-readable; when it crashes, the stack
trace goes to **stderr**. Keep a per-session ring buffer of the last ~64KB of
stderr, attach its tail to any error report, and show it behind a details
toggle on the setup page.

### Optional protocol trace

`KIROCHROME_TRACE=1` writes every JSON-RPC frame, both directions, to a JSONL
file. Off by default, trivial to implement, and the difference between guessing
and knowing when an agent misbehaves.

### Rules

- No empty `catch`. No generic "something went wrong".
- Every RPC has a timeout; a hung request must become an error, never a
  permanent spinner.
- Preserve `cause` when wrapping. Never discard the underlying error.
- Redact `env` from anything logged.

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
