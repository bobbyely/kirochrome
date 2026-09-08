# KiroChrome — Design

**Status:** proposed, not yet implemented.
**Date:** 2026-09-09

## Goal

A browser chat UI with the ergonomics of Claude Code / Codex desktop apps —
streaming output, real markdown and code rendering, tool-call and diff views,
resumable history — driven by the Kiro CLI.

## The constraint that shapes everything

Kiro CLI is only available on a work machine. Development happens on a personal
Linux box without it. Therefore:

> The app must be fully buildable and testable against a **fake** agent, and
> switch to the real Kiro with **configuration, not code**.

This is not a "nice to have for testing" — it is the primary development
workflow. Every phase below must be demoable with the fake backend.

Targets: **macOS and Linux** first-class. Windows is best-effort — it works if
the underlying CLI does, and we avoid anything that makes it hard (see
Portability).

## Architecture

```
 browser (React + Vite)
        │  WebSocket
        ▼
 server (Node + TypeScript)
   ├─ SessionManager ─── Session ─── event log (JSONL on disk)
   │                        │
   │                        ▼
   └────────────────── AgentBackend (interface)
                            ├─ MockBackend   ← development, tests
                            └─ CliBackend    ← Kiro, configured by a profile
```

### Key decision 1 — the event log is the source of truth

Every session is an **append-only log of typed events**: user messages,
assistant text deltas, tool calls, tool results, errors. The server appends;
the browser is a pure renderer of the log plus a live tail.

Everything good falls out of this one choice:

- refresh the page mid-turn → replay the log, nothing lost
- restart the server → sessions resume from disk
- two tabs on one session → both render the same log
- scrollback search, export, replay for debugging → just reading the log

The alternative — pushing UI updates and holding state in React — makes each
of those a separate feature you bolt on later, badly. Storage starts as JSONL
files (trivial, greppable, human-readable); SQLite only if search demands it.

### Key decision 2 — one generic CLI backend, configured by profiles

Not a class per agent. A single `CliBackend` that takes a **profile**:

```ts
type Profile = {
  command: string          // "kiro"
  args: string[]           // ["chat", "--no-interactive", ...]
  input: 'argv' | 'stdin'  // how the prompt is delivered
  parser: 'jsonl' | 'text' // how output is interpreted
  cwd?: string
}
```

Profiles live in a config file. Adding Kiro at work is editing config. Adding
Claude Code or Codex later is editing config. This keeps the surface small
(KISS) and makes the unknown-Kiro-interface risk cheap to absorb.

`PtyBackend` is the escape hatch if Kiro turns out to be interactive-only —
same interface, added only if the probe proves it necessary.

### The backend interface

```ts
interface AgentBackend {
  start(): Promise<void>
  send(text: string): void          // push user input
  events: AsyncIterable<AgentEvent> // backend → server
  interrupt(): void
  stop(): Promise<void>
}

type AgentEvent =
  | { type: 'turn_start';  turnId: string }
  | { type: 'text_delta';  text: string }
  | { type: 'tool_call';   id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  | { type: 'turn_end';    turnId: string; reason: string }
  | { type: 'error';       message: string }
```

Deliberately small. It is the *lowest common denominator* of every CLI agent,
not a mirror of Kiro's feature set. A parser's job is to map messy CLI output
onto these events; if it can only produce `text_delta`, the app still works.

## The open question: how Kiro is driven

Unknown until probed. Three possibilities:

1. **Structured streaming** (`--output-format json` or similar) — best case,
   `parser: 'jsonl'`, we get real tool events.
2. **Headless one-shot** (`kiro chat --no-interactive "prompt"`) — likely.
   Stateless per turn, so *we* own conversation state and replay it. Clean.
3. **Interactive TUI only** — needs `PtyBackend`, ANSI stripping,
   screen-scraping. Brittle; avoid unless forced.

`scripts/probe-agent-cli.sh` captures what's needed to decide. Run it on the
work machine, review the output for anything work-sensitive, bring back the
file.

## Portability

- `spawn` with an **args array**, never a shell string — avoids quoting bugs
  and shell-injection, and behaves the same on all three platforms.
- **No native modules in v1.** `node-pty` needs a toolchain and is the main
  thing that breaks Windows installs; it only enters if the probe forces it.
- Paths via `node:path`; session data under an OS-appropriate data dir.
- Windows caveat: npm-installed CLIs are `.cmd` shims that `spawn` won't run
  without `shell: true`. Handled in one place if we get there.

## Build order

Each phase ends with something demoable against `MockBackend`.

| Phase | Delivers | Done when |
|---|---|---|
| **0** | Probe Kiro; pick the parser strategy | We know which of the 3 modes applies |
| **1** | Walking skeleton: server + WS + React, one session, plain text streaming | Type a prompt, see tokens arrive |
| **2** | Event log on disk, reconnect and resume, markdown + syntax highlighting | Refresh mid-turn, lose nothing |
| **3** | Tool-call cards, file diffs, approval prompts | A tool call renders as a card, not a text blob |
| **4** | Multiple sessions, tabs, history, search | Switch between two live sessions |

Phase 0 can run in parallel with 1 — phase 1 doesn't need real Kiro.

## Security

v1 binds `127.0.0.1` with no auth. This process spawns an agent that executes
commands, so:

- bind loopback explicitly (not `0.0.0.0`)
- check WebSocket `Origin` even on localhost — any page in your browser can
  open a WS to localhost otherwise
- no secrets in the event log; redact env before logging spawn details

LAN/remote access is deliberately out of scope until after phase 4, and would
need a shared token at minimum.

## Rejected alternatives

- **SSE + POST instead of WebSocket** — traffic is genuinely bidirectional
  (interrupts, approvals, input during a turn). SSE means two channels to keep
  in sync.
- **Python/FastAPI backend** — fine on merit, but a TS server shares event type
  definitions with the React client, which removes a whole class of drift bugs.
- **Browser talks to Kiro directly** — impossible; a page can't spawn processes.
- **Electron/desktop wrapper** — the browser *is* the point.
