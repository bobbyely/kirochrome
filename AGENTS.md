# Steering — KiroChrome

Read this before writing code. This file is **the rules**; everything else is
one click away.

| Document | What it is for |
|---|---|
| [AGENTS.local.md](AGENTS.local.md) | **Your** preferences, layered over this file |
| [docs/DESIGN.md](docs/DESIGN.md) | Why the architecture is the way it is |
| [docs/PLAN.md](docs/PLAN.md) | What to build next, and recorded debt |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | What we implement of ACP, and how it actually behaves |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Adding an agent, and what has really been run |
| [docs/GOTCHAS.md](docs/GOTCHAS.md) | Traps that have already cost someone a day |
| [docs/REVIEWS.md](docs/REVIEWS.md) | The review log — read the range, not the date |
| [docs/PRIOR-ART.md](docs/PRIOR-ART.md) | Kirodex: what to borrow, what not to port |

**[AGENTS.local.md](AGENTS.local.md) wins over this file** where the two
disagree — it is the personal layer, and it ships blank. The exception is the
invariants below: those are correctness and security properties rather than
preferences, so changing one means editing this file, deliberately and visibly.

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
   `availableModes`). A new model appearing must require no code change, and no
   code branches on a provider `id` — branch on what was advertised.
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
12. **Advertising a capability is a promise.** Anything added to
    `clientCapabilities` must have a handler before it ships. Agents check the
    capability and then call.

## Conventions

- **TypeScript strict.** No `any` — use `unknown` and narrow.
- **Validate at the two boundaries that are not ours**: the WebSocket frame
  from the browser (`ws.ts`) and the hand-edited `config.json` (`config.ts`).
  Both are currently `JSON.parse(...) as T`, which is a lie — see the debt
  section in [PLAN.md](docs/PLAN.md). Agent payloads come from a process we
  spawned and are narrowed rather than validated; that is a deliberate
  difference, not an oversight.
- Guard clauses and early returns over nested conditionals.
- Small modules with one job. `SessionManager` manages sessions; it does not
  also own the database.
- Prefer clarity over cleverness. This is read more than written.
- Comments explain *why*, not *what*. No comment restating the next line.
- **Ask before adding a dependency.** No native modules without discussion —
  `node:sqlite` is built in, and avoiding a build toolchain is a portability
  requirement, not a preference.

## Where things live

`shared` is imported by both sides, so the wire format cannot drift.

**`packages/server`** — the ACP client.

| File | Job |
|---|---|
| `index.ts` | Boot: reap orphans *once*, then serve |
| `http.ts` | JSON API (providers, checks, search, export) + SPA, with the `Origin` allowlist |
| `ws.ts` | The socket at `/ws`; client message dispatch |
| `sessionManager.ts` | Session registry and single-flight resume |
| `session.ts` | **The big one.** ACP connection, event log, turns, queue, permissions, config options, commands |
| `agentProcess.ts` | Spawn in a process group, stdio → `ndJsonStream`, stderr ring buffer |
| `check.ts` | The seven-rung provider check ladder |
| `config.ts` | Provider registry in `config.json` |
| `configOptions.ts` | Merges `configOptions` with the legacy `models`/`modes` |
| `store.ts` | `node:sqlite`: events, sessions, checks, FTS5 search |
| `terminals.ts` | `TerminalRegistry` — caps, truncation, group kill |
| `processLedger.ts` | PID ledger and startup reaping |
| `fs.ts` | `fs/read_text_file`, `fs/write_text_file` |
| `export.ts`, `resolve.ts`, `ringBuffer.ts`, `paths.ts`, `trace.ts` | Markdown export, `PATH` resolution, stderr buffer, per-OS data dir, frame trace |

**`packages/shared`** — `events.ts` (event payloads, usage derivation),
`errors.ts` (`KcError`, the closed code enum, remediations), `providers.ts`
(provider config, check results, HTTP payloads), `ws.ts` (socket messages).

**`packages/web`** — `App.tsx` routes; `Chat.tsx` is **the other big one**
(transcript, composer, completion, every row renderer); `timeline.ts` folds
events into typed rows; `useChat.ts` is the socket and resume-by-seq;
`Setup.tsx` is the ladder UI; then `Sidebar`, `NewChat`, `commands`, `diff`,
`images`, `theme`, `useShortcuts`, `Markdown`, `KSpinner`, `api`.

**`spike/`** is misnamed — see the debt section in [PLAN.md](docs/PLAN.md).
`mock-agent.mjs` is a load-bearing test fixture and a seeded provider, not a
throwaway; `handshake.mjs` is the probe you use when onboarding an agent.

## Definition of done

Before you call anything finished:

1. **`npm test`** — builds, then runs both suites. Not "should work".
   Behaviour claims are verified by running something.
2. **Docs updated in the same commit.** Which one depends on what changed:

   | You changed | Update |
   |---|---|
   | An invariant, a convention, the code map | `AGENTS.md` |
   | The architecture, or a decision behind it | `docs/DESIGN.md` |
   | Scope, roadmap, or debt | `docs/PLAN.md` |
   | Anything about how ACP behaves | `docs/PROTOCOL.md` |
   | A provider, or what has been run against | `docs/PROVIDERS.md` |
   | Anything user-visible: flags, env vars, setup | `README.md` |

   Docs drift silently and are found much later. `README.md` claimed
   "implementation not started" through six shipped phases.
3. **A new failure path needs an error code and a remediation.** A new `throw`
   without one is incomplete work.
4. **A fixed bug needs its test and its gotcha.** Add the case to the suite and
   the trap to [docs/GOTCHAS.md](docs/GOTCHAS.md). Every entry in there exists
   because something was once wrong.
5. **A review gets a row** in [docs/REVIEWS.md](docs/REVIEWS.md), even a review
   that found nothing. An absent row is indistinguishable from a skipped one.

## Tests

`npm test` builds, then runs both suites. No test dependencies: `node:test` and
`--experimental-strip-types` are built into Node 22.

- `packages/web/src/__tests__/*.test.ts` — pure logic (diffing, folding the
  event log into rows), run directly as TypeScript.
- `packages/server/test/*.test.mjs` — run against `dist`, so they exercise what
  actually ships. Node's type stripping does not rewrite `.js` specifiers to
  `.ts`, which is why these are plain `.mjs` importing the build.

**CI runs `npm run typecheck` and `npm test` on every push to `main` and every
pull request** (`.github/workflows/ci.yml`, Node pinned from `.nvmrc`). It
installs `spike/` separately, because that is where the mock agent's copy of the
ACP SDK lives and the server suite spawns it.

`session.test.mjs` drives the real mock agent over ACP, so it covers the
behaviours that are easy to break: delta coalescing, queue ordering, replay
suppression on resume, and defaults surviving a withdrawn option.

## Debugging

When something misbehaves, in this order:

1. **Read the agent's stderr.** Its stdout is the JSON-RPC channel and carries
   nothing human-readable; crashes and stack traces go to stderr. The ring
   buffer is on the session, and its tail is attached to error reports.
2. **Turn on the frame trace** — `KIROCHROME_TRACE=1` writes every JSON-RPC
   message in both directions to JSONL. Use it before theorising.
3. **Re-run the provider check.** It reports the exact rung that failed.

Preserve these three. Removing diagnostics to "clean up" is a regression.

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

**Message style:** a prose sentence saying what the change does, in the
imperative — "Support the agent's slash commands, which is where Kiro hides
effort". Not Conventional Commits; no `feat:` prefixes.

### Changes land through a pull request

**Branch, push, open a PR, and merge only once CI is green.** Not because
anyone is waiting to review it — because the check is what stops bad code
reaching `main`, and fixing `main` after the fact is strictly worse than
fixing a branch.

```bash
git checkout -b <topic>
git push -u origin <topic>
gh pr create
gh pr merge --rebase --delete-branch   # after the check passes
```

**Rebase, never merge-commit.** The history here is linear and worth keeping
that way.

**Nobody approves these.** GitHub does not let you approve your own pull
request, so requiring a review would deadlock a single-contributor repo
permanently. The gate is the CI check, not a human approval — if `main` is ever
protected, require the status check and leave reviews unrequired.

The exception is a change CI cannot break and a branch cannot help: a typo in a
doc, say. Direct is fine there. When in doubt, branch — it costs one command.

## Working style

- Research → plan → implement. Read the existing code before adding to it.
- Follow [docs/PLAN.md](docs/PLAN.md). Each item must end in something
  runnable; do not build scaffolding for a later one.
- When the protocol is unclear, **check the spec at
  <https://agentclientprotocol.com>** rather than guessing. This project has
  already been rewritten once because of an assumption about a CLI's interface,
  and every protocol note in [docs/PROTOCOL.md](docs/PROTOCOL.md) was found by
  reading the spec after the fact.
- Verify claims about behaviour by running something. "Should work" is not done.

## Communicating

About the agent's own output, not the product's. Written to hold for whatever
model is driving.

Keep responses focused and brief. Most of the response goes on the main answer;
caveats and disclaimers stay short. When asked to explain something, give a
high-level summary unless depth was asked for.

- **Lead with the outcome.** The first sentence after finishing answers "what
  happened" or "what did you find" — the thing you would say if asked for the
  TLDR. Reasoning and detail come after, for whoever wants them.
- **Readable beats short.** If the reader has to reread it or ask what you
  meant, brevity saved nothing. Shorten by dropping what does not change what
  they do next, not by compressing into fragments, arrow chains (`A → B →
  fails`) or unexpanded jargon.
- **Match the shape to the question.** A direct question gets a direct answer
  in prose. Tables are for short enumerable facts; if the cells hold
  explanations, it wanted to be a paragraph.
- **Write for a teammate catching up, not a log file.** They did not watch the
  work happen and do not know the names you coined along the way. Say in a
  sentence what you are about to do before the first tool call, then update
  only when you find something load-bearing or change direction.
- **Correct only what changes the reader's decision.** Fix the slip and carry
  on; do not narrate it, tally it, or apologise for it.
- **No preamble, no wrapper.** Do not restate the question, announce what you
  are about to say, or close with a paragraph that summarises what the reader
  just read. Start at the answer and stop when it is answered.
- **A file's length is a separate habit.** Documents, reports and summaries
  written to disk drift long independently of chat replies. Cover the substance
  and stop — no filler sections, no restated summaries, no boilerplate.

**Model-specific tuning does not belong here.** Instructions that counter one
model's habits — "double-check your work", "delegate more", "delegate less" —
invert from one generation to the next, so they belong in the per-tool file
(`CLAUDE.md` and its equivalents) where they can be retired with the model that
needed them. What stays in this section is the shape of good writing, which
does not turn over.
