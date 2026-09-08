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

- **Models are only known after `session/new`.** The picker cannot be populated
  before a session exists — hence draft sessions. Do not "fix" this by
  hardcoding a list.
- **Killing a shell does not kill its children.** Kill the process group
  (`process.kill(-pid, …)`), SIGTERM then SIGKILL after a grace period, or
  orphans survive and the terminal appears hung.
- **Do not write a database row per streamed token.** Coalesce deltas on a
  ~250ms flush.
- **`node:sqlite` warns on Node 22**, stable on 24. Pin via `.nvmrc`. Do not
  swap it for a native module to silence the warning.
- **Never log `env`** when logging a spawn.

## Working style

- Research → plan → implement. Read the existing code before adding to it.
- Follow [docs/PLAN.md](docs/PLAN.md) phase order. Each phase must end in
  something runnable; do not build phase 4 scaffolding during phase 1.
- When the protocol is unclear, **check the spec at
  <https://agentclientprotocol.com>** rather than guessing. This project has
  already been rewritten once because of an assumption about a CLI's interface.
- Verify claims about behaviour by running something. "Should work" is not done.
