# Steering — KiroChrome

Read this before writing code. [docs/DESIGN.md](docs/DESIGN.md) explains *why*;
this file is the rules. [docs/PLAN.md](docs/PLAN.md) says what to build next.

## What this is

A browser chat UI for CLI coding agents. A local Node server implements the
**ACP client** role, spawns an agent subprocess (`kiro-cli acp` and friends),
and streams it to a React app over a WebSocket.

We are a **client**. We are not writing an agent, a model wrapper, or a CLI.

## Invariants

Breaking one of these is a design regression, not a style nit.

1. **ACP is the only way we talk to agents.** No parsing CLI stdout, no ANSI
   stripping, no PTY, no screen-scraping. If an agent does not speak ACP, it
   needs an adapter — that is the adapter's problem, not ours.
2. **`events` is append-only.** INSERT only. Never UPDATE, never DELETE. The
   `sessions` table is a derived index that must be rebuildable by replaying
   `events`.
3. **The browser never holds authoritative state.** It renders the event log
   and a live tail. If a feature needs client-side state to be correct, the
   design is wrong — add an event type instead.
4. **A turn is owned by the server, not the socket.** A browser disconnect must
   never cancel or lose a running turn.
5. **Never hardcode provider, model or mode lists.** Render whatever the agent
   advertises via `configOptions` (or the legacy `availableModels` /
   `availableModes`). A new model appearing must require no code change.
6. **Every spawned process is tracked and killable.** Registered on create,
   spawned in its own process group, killed as a group, released on session
   close. No exceptions — this is where hangs come from.
7. **`127.0.0.1` only, and check the WebSocket `Origin`.** Any page in the
   user's browser can open a socket to a local server otherwise.
8. **Wire types live in `packages/shared`** and are imported by both sides.
   Never redeclare a message shape in `server` or `web`.
9. **Errors are typed, never strings.** Every failure is a `KcError` with a
   code from the closed enum and a remediation. No empty `catch`, no generic
   "something went wrong", no discarded `cause`.
10. **Every RPC has a timeout.** A hung request must become a typed error. A
    permanent spinner is a bug, not a state.
11. **A provider is usable only after its setup check passes.** The chat flow
    does not re-diagnose; it trusts the check. Runtime failures mark the
    provider `stale` and send the user back to setup.

## Conventions

- **TypeScript strict.** No `any` — use `unknown` and narrow. Protocol payloads
  are parsed at the boundary, not cast.
- Guard clauses and early returns over nested conditionals.
- Small modules with one job. `SessionManager` manages sessions; it does not
  also own the database.
- Prefer clarity over cleverness. This is read more than written.
- Comments explain *why*, not *what*. No comment restating the next line.
- **Ask before adding a dependency.** No native modules without discussion —
  `node:sqlite` is built in, and avoiding a build toolchain is a portability
  requirement, not a preference.

## Gotchas that have already bitten this design

- **Models are only known after `session/new`.** The composer's pickers cannot
  be populated before a session exists, which is why a session is created as
  soon as a provider is chosen. Do not "fix" this by hardcoding a list.
- **Agents emit both config dialects at once**, sometimes with different
  settings in each. Merge `configOptions` with the legacy `models`/`modes`
  rather than letting one hide the other.
- **`session/cancel` is a notification, not a request.** Awaiting a reply makes
  Stop hang forever and appear to do nothing.
- **`white-space: pre-wrap` must not reach markdown rows.** It renders the
  newlines between block elements literally, double-spacing every paragraph.
- **Probe an optional extension once, then stop.** `_kiro.dev/commands/options`
  is an ACP extension, not the standard; a failed call marks it unsupported for
  that session rather than being retried on every keystroke.
- **Not every agent setting is a `configOption`.** Slash commands are the other
  half: advertised by `available_commands_update` and run as ordinary prompt
  text. Kiro exposes reasoning effort only that way, so a missing picker does
  not mean a missing feature.
- **`session/load` returns `modes` and `configOptions` too**, exactly as
  `session/new` does. Discarding its response leaves a resumed conversation
  with no pickers at all.
- **Single-flight anything that awaits before registering itself.** `resume`
  awaits a handshake, so two calls arriving in that window each built a Session
  for the same conversation — both appending from the same seq, and each with
  its own agent process.
- **Identify a process by its start time, not its command line.** A shell may
  exec-replace itself (`sh -c "sleep 30"` becomes `sleep 30` under bash but not
  dash), so command text is unreliable; start time survives an exec and changes
  on PID reuse.
- **The WebSocket lives at `/ws`.** At `/` it collides with Vite's hot-reload
  socket, and dev mode silently never connects.
- **Register a pending resolver before announcing the event that asks for it.**
  `append` notifies subscribers synchronously, so an answer arriving
  synchronously would find no pending entry and be dropped, blocking the agent
  forever. This is exactly how the permission race was found.
- **Reap orphaned processes once at startup, never per session** — per-session
  reaping kills processes belonging to sessions that are still alive.
- **Killing a shell does not kill its children.** Kill the process group
  (`process.kill(-pid, …)`), SIGTERM then SIGKILL after a grace period, or
  orphans survive and the terminal appears hung.
- **Do not write a database row per streamed token.** Coalesce deltas on a
  ~250ms flush.
- **`node:sqlite` warns on Node 22**, stable on 24. Pin via `.nvmrc`. Do not
  swap it for a native module to silence the warning.
- **Never log `env`** when logging a spawn.

## Committing

**Commit as the repository's own git identity.** Run plain `git commit` and let
it use the configured `user.name` / `user.email`. Record Claude's contribution
with a `Co-Authored-By:` trailer and nothing else.

**Never pass `-c user.email=...` or `--author`** unless the user explicitly asks
for a specific author.

**Why:** an agent session may be handed a plus-alias address such as
`name+claude@example.com`. GitHub does not map a plus-alias to the owner's
account, so commits made with one are attributed to a separate identity — the
repo owner ends up listed as a co-author on their own work, and the contributor
graph is wrong. It happened here: the first nine commits had to be rewritten.
The session-supplied email identifies the user; it does not stamp authorship.

## Prior art: Kirodex

[thabti/kirodex](https://github.com/thabti/kirodex) — MIT, Tauri 2 + Rust +
React — is the same problem in a different shell: a desktop UI over `kiro-cli`,
**also built on ACP**. Independent confirmation that our transport choice is
right, and the most useful reference we have for interaction design.

**Read it for interaction design and event shaping. Do not port code.** It is
Tauri with Rust IPC, `portable-pty` and `redb`; we are a browser talking to a
Node server over a WebSocket. Its plumbing assumptions do not transfer, its UI
decisions do.

Where to look, by problem:

| Problem | Look at |
|---|---|
| Folding an event log into renderable rows | `MessageList.logic.ts`, `TimelineRows.tsx`, `WorkGroupRow.tsx` |
| Tool call rendering | `ToolCallEntry.tsx` (collapsed) vs `ToolCallDisplay.tsx` (expanded), `tool-call-utils.ts` |
| Read/edit tool output | `ReadOutput.tsx` (syntax-highlighted), `InlineDiff.tsx` |
| Turn boundaries and progress | `WorkingRow.tsx`, `CompletionDivider.tsx`, `ThinkingDisplay.tsx` |
| Approvals | `PermissionBanner.tsx`, `AutoApproveToggle.tsx`, `QuestionCards.tsx` |
| Model / mode / effort selection | `ModelPicker.tsx`, `ModelPickerPanel.tsx`, `ReasoningEffortPicker.tsx` |
| CLI detection and first-run setup | `OnboardingCliSection.tsx` |
| Context window pressure | `ContextUsageBar.tsx`, `ContextRing.tsx`, `CompactSuggestBanner.tsx` |

Patterns worth adopting, and why:

- **Typed timeline rows, not a message array.** They fold the event stream into
  rows with an explicit taxonomy (`user-message`, `system-message`,
  `assistant-text`, `work`, `working`, `changed-files`) and per-type height
  estimates for virtualization. Our `packages/web/src/timeline.ts` does the
  fold; the row taxonomy and virtualization are what it still lacks.
- **Queue messages typed during a turn.** `QueuedMessages.tsx` lets the user
  type while the agent runs; messages queue and send when the turn ends, and can
  be reordered, edited or removed first. This is the single best turn-handling
  idea in the repo — a running turn should never block the composer.
- **Collapsed by default, expandable on demand.** A tool call is one dense line
  until you open it. A transcript of expanded tool output is unreadable.
- **Selection is per-thread, live, and restored.** Model and mode changes apply
  mid-session and survive reconnects and restarts — which is exactly what ACP
  `configOptions` allows, and why we never cache a model list in code.
- **Detection with a manual fallback.** Their onboarding auto-detects the CLI,
  offers per-platform install commands when it fails, and lets the user browse
  to a path. Our `AGENT_NOT_FOUND` should grow the same two affordances.

## Tests

`npm test` builds, then runs both suites. No test dependencies: `node:test` and
`--experimental-strip-types` are built into Node 22.

- `packages/web/src/__tests__/*.test.ts` — pure logic (diffing, folding the
  event log into rows), run directly as TypeScript.
- `packages/server/test/*.test.mjs` — run against `dist`, so they exercise what
  actually ships. Node's type stripping does not rewrite `.js` specifiers to
  `.ts`, which is why these are plain `.mjs` importing the build.

`session.test.mjs` drives the real mock agent over ACP, so it covers the
behaviours that are easy to break: delta coalescing, queue ordering, replay
suppression on resume, and defaults surviving a withdrawn option.

**When you fix a bug, add the case.** Every test in there exists because
something was once wrong.

## Debugging

When something misbehaves, in this order:

1. **Read the agent's stderr.** Its stdout is the JSON-RPC channel and carries
   nothing human-readable; crashes and stack traces go to stderr. The ring
   buffer is on the session, and its tail is attached to error reports.
2. **Turn on the frame trace** — `KIROCHROME_TRACE=1` writes every JSON-RPC
   message in both directions to JSONL. Use it before theorising.
3. **Re-run the provider check.** It reports the exact rung that failed.

Preserve these three. Removing diagnostics to "clean up" is a regression.

## Working style

- Research → plan → implement. Read the existing code before adding to it.
- Follow [docs/PLAN.md](docs/PLAN.md) phase order. Each phase must end in
  something runnable; do not build phase 4 scaffolding during phase 1.
- When the protocol is unclear, **check the spec at
  <https://agentclientprotocol.com>** rather than guessing. This project has
  already been rewritten once because of an assumption about a CLI's interface.
- Verify claims about behaviour by running something. "Should work" is not done.
- **When adding a failure path, add an error code and remediation with it.**
  A new `throw` without a code is incomplete work.
