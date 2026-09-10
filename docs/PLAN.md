# KiroChrome — Implementation Plan

Companion to [DESIGN.md](DESIGN.md). Each phase ends with something you can
actually use; no phase is pure scaffolding.

## Development agent

Kiro is on the work machine, so we develop against **Claude Code via the ACP
adapter** (`npx -y @agentclientprotocol/claude-agent-acp`), which is what the
seeded provider in `config.ts` spawns and the one verified through all seven
rungs — see [PROVIDERS.md](PROVIDERS.md#what-has-actually-been-run). Because both speak ACP, "make it work with Kiro" is a config entry,
not a port. We develop against a real agent the whole way.

Phase 0 verifies that assumption before anything is built on it.

## Repo layout

```
kirochrome/
├── packages/
│   ├── shared/   types: WS messages, event payloads, error codes, config
│   ├── server/   ACP client, SessionManager, TerminalRegistry, store, WS
│   └── web/      React + Vite
├── spike/        the mock agent and the handshake probe — see debt, below
└── docs/         DESIGN (why) · PLAN (next) · PROTOCOL · PROVIDERS · GOTCHAS · REVIEWS
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

Phases 0–6 are built and verified locally against Claude Code and an offline
mock agent. A clean checkout installs, typechecks, builds and runs.

**Setup:** a seven-rung check ladder that reports which rung failed, with
per-platform install hints and a field to correct a binary path. Providers go
`stale` on a runtime failure and drop out of the new-chat list.

**Chat:** streaming responses with markdown and syntax highlighting; tool calls
folded into collapsible cards showing real diffs; runs of tool calls grouped
into one row; permission prompts that block the agent until answered;
structured questions rendered as forms; context-window meter and a compaction
seam when history is replaced; image paste; messages queued while a turn runs.

**Conversations:** persisted and resumable via `session/load`; renameable,
archivable, exportable to Markdown; full-text search across all of them; a
sidebar with live per-conversation status. Conversations started in the agent's
own CLI can be listed with `session/list` and taken over here.

**Process safety:** agents and their commands run in their own process groups
and are killed as groups; a ledger reaps anything a crashed server left behind,
guarded against PID reuse.

**Slash commands:** advertised by `available_commands_update` and run as
ordinary prompt text. This is how Kiro's reasoning effort is reachable, and why
it never appeared in a picker — see
[PROTOCOL.md](PROTOCOL.md#slash-commands-are-the-other-half-of-configuration).

### What is left

#### 1. The side pane — changes and files

A drawer that slides over the transcript, with two tabs. They are one surface,
not two features: both answer "what is in this project right now".

**Changes.** Every file the agent has touched this conversation, with its diff,
rather than hunting the transcript for the tool call that did it. The data is
already there — `ToolCallContent` diffs carry `path`, `oldText`, `newText`, and
`timeline.ts` extracts them. The work is aggregating per file across the log
(last write wins per path, with a running +/− count) and the panel.

*Decide:* reported diffs only, or read the working tree. Reported diffs need no
filesystem access and stay honest about what the agent claims it did; the tree
shows ground truth but can disagree with the transcript. Either survives a
restart, since the diffs are in the event log.

**Files.** A *renderer*, not a text dump: each format shown the way it is meant
to be read, with a tree to navigate the session's working directory. Read-only
to begin with — editing invites a race with the agent writing the same file.

| Format | Rendered as | What exists already |
|---|---|---|
| Code | Highlighted, with line numbers | `rehype-highlight`, used by tool cards |
| Markdown | Rendered, with a toggle to source | `MarkdownBody` |
| JSON / YAML | Pretty-printed and highlighted | highlighting; formatting is new |
| CSV / TSV | A table | new |
| Images | Inline | serving is new — see below |
| PDF | Embedded viewer | new; the browser can do this |
| Binary / very large | Say so, with size and type | new — never dump bytes |

**The complication: ACP's `fs/read_text_file` is text-only.** Images, PDFs and
anything binary need a separate route, and that route has a different trust
boundary from the ACP methods.

The ACP handlers serve *the agent*, a local process that can already read
anything the user can, so they are deliberately unsandboxed. An HTTP endpoint
serves *the browser*, and any page the user has open can attempt a request to
localhost — we check `Origin`, but that is one control, not a boundary. So the
file endpoint must be confined to the session's working directory, with the
resolved real path checked to be inside it after symlinks are followed. Sharing
the unsandboxed ACP path would turn a chat UI into a read-anything endpoint.

Worth deciding early: whether the tree also shows files ignored by git. Showing
`node_modules` makes it useless; hiding it by reading `.gitignore` is more work
than it sounds, and hiding files the agent is actively editing would be worse.

#### 2. Switch provider without leaving the conversation

Put **Provider** first in the composer's config row, before the model and the
rest of the options advertised by that agent. It lists providers whose setup
check passed, using their configured names (for example Anthropic, OpenAI and
Kiro). Choosing one keeps the same window, URL, sidebar entry and transcript.

This is a KiroChrome handoff, not an ACP session transfer: one provider cannot
load another provider's session id. Wait for the current turn to finish, start
a fresh ACP session for the target provider in the same working directory, and
give it the conversation so far as context. The working tree already carries
the file changes; the handoff context carries what was said and the useful
outcomes of tool calls, without protocol bookkeeping, usage updates or raw
command noise.

The event log remains the one conversation. Append a `provider_switched` event
that records the old and new provider and the last sequence included in the
handoff, and render it as a divider such as "Continued with OpenAI · Codex".
That makes the context boundary durable and visible rather than hiding an
injected prompt in browser state. Once the new agent is ready, its advertised
models, modes, effort and other `configOptions` replace the old controls in
place. Switching again repeats the same process with another fresh agent
session and the complete transcript through the new boundary.

Do not tear down the current agent until the replacement has completed its
handshake and `session/new`; a failed switch must leave the conversation usable.
Only checked providers are offered. A switch waits while a turn, permission,
elicitation or queued message is outstanding, so ownership never moves while
work is in flight.

Context size needs an honest first version. Serialize user and agent prose plus
concise tool outcomes. If it does not fit the target agent, require compaction
first or send a clearly marked recent tail; KiroChrome has no model of its own
with which to invent a hidden summary.

#### 3. `session/fork` — branch a conversation

"Try a different approach from here" without losing the original. The event log
makes the branch point natural to show, and neither CLI exposes this well.

**It is the one unstable capability of the five.** The v1 schema marks `fork`
"not part of the spec yet, and may be removed or changed at any point", while
`list`, `resume`, `delete` and `close` carry no such warning — found while
building `session/list`, and written up in
[PROTOCOL.md](PROTOCOL.md#sessionlist-is-real-v1-and-planmd-was-nearly-right-about-it).
So this one needs a way to degrade when it disappears, which listing did not.

#### 4. `@` file mentions in the composer

Type `@` to complete against the working directory and attach file contents as
`resource_link` blocks. The completion machinery built for slash commands
generalises to this, and `fs` is now implemented.

#### 5. Interrupt and send

Today a message typed during a turn queues and goes when the turn ends. The
other useful thing to do with it is send it *now*.

**ACP v1 cannot inject into a running turn.** There is no method for it: the
only mid-turn traffic is permission responses and `session/cancel`, and a turn
ends on a `stopReason`. So this is `session/cancel` → await the `cancelled`
stopReason → `session/prompt` with the new text. The agent keeps everything
already streamed in its context, but in-flight tool calls are abandoned and the
spec requires they be marked `cancelled`.

Call it **Interrupt and send**, not Steer. Steering implies the agent absorbs
the message mid-flight, which is not what happens; the first person to use it
during a long tool call and watch the work vanish should not be surprised.

The shape: a per-queued-message flag, a client message, the cancel-then-prompt
sequence in `Session`, and **an event recording the interruption** so the
transcript shows why a turn ended early — invariant 3, this cannot be UI state.
The queue, turn ownership and the message editing are all already there.

Real steering arrives with **ACP v2**, which decouples the prompt response from
the work lifecycle precisely so queueing and steering are expressible. It is
Draft; see [PROTOCOL.md](PROTOCOL.md#steering-and-acp-v2).

#### 6. Instructions of your own, across every agent

Agents already read their own user-level instruction files, and the session's
`cwd` gives them the project's `AGENTS.md`. What is missing is a KiroChrome
layer: write your style once and have it hold whether you are on Kiro, Claude
Code or Gemini.

A file in the data directory, editable from the setup page, prepended to a
session's context.

*Decide when building it:*

- **Global, per-provider, or both.** Both is the honest answer and the most
  configuration; start global.
- **First prompt or every prompt.** First is cheaper and usually enough, but a
  long conversation drifts away from it.
- **It must be visible in the transcript.** Injecting text into a prompt that
  the user cannot see is how you get a session nobody can debug, and it would
  be state the log does not hold. It goes in as an event.

Do not confuse this with [AGENTS.local.md](../AGENTS.local.md), which steers
agents working *on this repo*. This one steers agents the user runs *through*
KiroChrome.

#### Deliberately not doing

- **`nes/*` (next edit suggestions)** and **`document/did*`** — both assume an
  editor with a cursor and a focused buffer. A browser chat is not that, and
  faking it would be worse than leaving it to an actual editor integration.

#### Periodic code review

Review after each roadmap item lands, not at some distant tidy-up. This
codebase has produced 25 recorded gotchas across 56 commits, and they cluster —
so a review here should look for the shapes that have actually bitten, rather
than generic style points:

- **Claims we do not honour.** We advertised `fs` capabilities for weeks with no
  handlers. Anything added to `clientCapabilities`, or any invariant written
  into AGENTS.md, is a promise — check it is kept.
- **Awaits that register too late.** The permission race and the concurrent
  resume were both "check, await, then register", where a second caller arrives
  in the window. Any new `async` path that looks something up before creating it
  deserves a second read.
- **Per-session versus global.** Orphan reaping and `TerminalRegistry` both
  started per-session and had to become global; the failure was quiet and
  cross-session. Ask what happens with two conversations open.
- **Protocol assumptions.** `session/cancel` being a notification,
  `session/load` returning config, both dialects arriving at once — every one
  was found by reading the spec after the fact. Check new protocol code against
  <https://agentclientprotocol.com>, not against what seems reasonable.

Two files have grown past comfortable and are the obvious first targets:
`session.ts` (799 lines) and `Chat.tsx` (770). Both do several jobs now —
`Session` owns process lifecycle, protocol handlers, the queue, permissions and
persistence, and `Chat` owns transport wiring, completion, and every row
renderer. Neither is urgent, but they are where the next subtle bug will hide.

**When you fix something a review finds, add the test and the gotcha.** That is
why the list above is specific enough to be useful.

Record each review in [REVIEWS.md](REVIEWS.md) — date, the commit it ran
through, and what it found. The range matters more than the date: the next
review starts where the last ended, and a missing row is indistinguishable from
a skipped review.

#### Bugs to fix

Wrong, not deferred. Debt below is a decision; this is a defect.

Found by the first review — see [REVIEWS.md](REVIEWS.md) — and left open. The
three it fixed (the Origin allowlist, terminals surviving a crashed agent, the
missing session RPC timeouts) are traps in [GOTCHAS.md](GOTCHAS.md) now, which
is where a fixed bug belongs.

- **`updateProvider` writes back the validated list, erasing what was dropped.**
  `config.ts:99`. `loadConfig` deliberately skips a malformed provider so the
  setup page still loads — but saving from that view makes the omission
  permanent, so correcting one provider's path in the UI silently deletes a
  hand-edited entry that had a typo in it. A lenient read is only safe while
  nothing writes back from it.
- **A read failure while serving a static file kills the server.**
  `http.ts:193`. `createReadStream(...).pipe(res)` has no `error` listener, and
  an unhandled `'error'` is fatal — a file that vanishes between the
  `existsSync` check and the read takes every running turn down with it.
- **Renaming an archived conversation un-archives it.** `session.ts:839`.
  `persistMeta()` hardcodes `status: "active"`, so any metadata write puts the
  conversation back in the sidebar.
- **A turn killed mid-flight leaves no `turn_end`.** A restart, or an agent
  dying during a turn, ends the transcript mid-answer with nothing saying why
  and leaves `turn_start` unmatched in the log — six of them in one development
  database. `runTurn`'s catch appends an error but never closes the turn, and
  `close()` sets `closing` before anything else can. Item 5 above needs exactly
  this event, so the two are worth doing together.
- **Agent-supplied diff paths are interpolated raw into the export's HTML.**
  `export.ts:43`. The export is a local Markdown file, so this is malformed
  output rather than a live injection — but the path comes from the agent.
- **`outputByteLimit` is unvalidated and counts UTF-16 units.**
  `terminals.ts:138`. An agent passing `0` or a negative number silently empties
  the whole output buffer instead of being told the value is wrong.
- **Orphan reaping is a silent no-op on Windows.** `processLedger.ts:36` shells
  out to `ps` for a start time, which does not exist there, so every ledger row
  records a blank one and `reapOrphans` declines them all. Windows is
  best-effort by design — but doing nothing quietly is worse than not
  supporting it.

#### Recorded debt

Known, deliberate, and not urgent — written down so it is a decision rather
than a surprise. Each entry says what would go wrong if it is left.

- **A dropped provider entry is only reported to stderr.** `loadConfig` now
  validates `config.json` and skips a broken provider rather than refusing the
  whole file, and returns what it skipped as `AppConfig.problems` — but the only
  consumer is a `console.warn`. A user editing the file by hand and getting a
  typo wrong sees their provider quietly absent from the setup page unless they
  are watching the server's output. Surfacing `problems` in
  `ProvidersResponse` and rendering it on the setup page is the fix, and is
  small; it was left out to keep the validation change to the boundary itself.
- **No formatter or linter.** Half the conventions section is mechanically
  enforceable and currently is not.
- **`spike/` is misnamed and load-bearing.** Its README says "throwaway", but
  `mock-agent.mjs` is a seeded provider *and* the fixture `session.test.mjs`
  drives, and `handshake.mjs` is the documented way to onboard an agent. It
  also sits outside the workspace with its own pin of
  `@agentclientprotocol/sdk`, so the SDK version has two places to bump and can
  drift between the probe and the server — and CI has to run a second `npm ci`
  inside it before the server suite can run at all. Renaming it is a rename plus
  a path in two files; folding it into the workspace would also remove that
  second install and the drift.
- **`packages/web/src` is flat** — twenty files, no directories. Fine now,
  awkward once the side pane lands.
- **`session.ts` (971) does several jobs.** Covered by the review section above;
  listed here so the debt is in one place. `Chat.tsx` has come down from 992 to
  711 with the composer split out, but it still owns the transcript, the scroll
  behaviour and every row renderer.
- **`buildRows` allocates fresh row objects on every event.** Harmless while
  typing, since the memo is keyed on an unchanged `events` array — but during a
  turn every delta rebuilds every row, so the `Message` memo bails out for none
  of them even though only the last row changed. Reusing unchanged rows across
  folds would make streaming cost proportional to what actually changed.
  **Not measured**, and it needs the fold to become incremental, which is a
  bigger change than it sounds.

#### Smaller, still open

- **Tool calls should stay collapsed, including while the turn runs.** The
  individual cards already are — `ToolCard` renders a `<details>` with no
  `open`. What expands is the *group*: `WorkGroup` initialises `open` from
  `row.active` and keeps following it until the user touches it, so a run of
  tools opens while it is working and collapses when the turn ends. The intent
  was to show live progress; the effect is that the transcript is at its most
  open exactly when it is moving fastest, and the page jumps. Collapse by
  default instead, and make the summary line carry enough — tool count, status
  mark, the command once it is known — to decide whether to open it.
- Verify the design pass on a real screen: the theme, the K spinner and the
  switch were all built without a browser to look at.
- True virtualisation, if the windowed transcript proves insufficient.
- Whatever the work machine turns up once Kiro is actually driving it.

### Done since the roadmap was written

**`session/list` landed, and this file was nearly right about it.** The method
is stable v1, not draft — but `sessionCapabilities` lives *inside*
`agentCapabilities` and its sub-capabilities are objects rather than booleans,
and of the five only `fork` is marked unstable. The correction that changed the
design: ACP still gates loading on the separate top-level `loadSession`, so an
agent can offer a conversation it cannot reopen. That has its own error code.
See [PROTOCOL.md](PROTOCOL.md#sessionlist-is-real-v1-and-planmd-was-nearly-right-about-it).

The note about those conversations having no event log turned out to be the
crux. Adopting one keeps the agent's `session/load` replay — the single case
where we do, because our log is empty and the replay is the only transcript
that exists — while an ordinary resume still discards it. Adoption mints a new
conversation id and every later reopen is a resume, so the history is captured
exactly once. An `adopted` event marks the seam, which is why the UI can say
where the agent's record ends and ours begins without holding that in the
browser.

**Both untrusted boundaries are validated, not cast.** A WebSocket frame is
checked field by field against a table keyed by `ClientMessage["type"]` before
dispatch, and a bad one is a `MESSAGE_INVALID` reply to that client instead of
a `TypeError` three calls deeper. `config.json` is checked the same way, with
one deliberate asymmetry: a single broken provider entry is dropped and
reported rather than failing the file, because that file holds every route back
into the app and the setup page is the only way to fix it.

The design pass landed: `styles.css` rebuilt around a type scale, a spacing
scale and one colour set, in the terminal-noir direction (near-black, one aqua
accent, monospace chrome, square corners). The animated working indicator
landed as the blocky K. Slash commands, terminal-style completion and
agent-supplied argument options landed after that.

CI landed: `npm run typecheck` and `npm test` run on every push and pull
request, and changes reach `main` through a PR that merges on green.

**Switching conversations no longer rebuilds the WebSocket.** `Chat` owns the
socket and was keyed on the session, so every switch closed the connection and
redialled one before it could ask for anything — a wait in front of a server
that was already able to serve the switch. The key is gone, attaching is driven
by the target changing, and the socket now views one conversation at a time:
`subscribe` replaces the previous session's listeners instead of adding to
them, which the accumulating version made a latent cross-session leak. The
first scroll into a conversation jumps rather than animating down from the top,
which was the other half of what felt slow. **The feel is unverified** — still
no browser on the dev box — but the leak and the switch over one socket are
both tests now.

**Typing no longer re-renders the transcript.** `draft` lived in `Chat`, which
also rendered every row, so each keystroke re-rendered up to 60 rows and
re-parsed the markdown in each of them. The composer — draft, images,
completion, the queue and the config pickers — is now `Composer.tsx`, and
`Message` and `MarkdownBody` are memoized as a backstop. **The improvement is
unverified:** there is still no browser on the dev box, so this was reasoned
rather than measured, and the discriminating test remains whether typing
degrades as the transcript grows.

**Conversations named by the agent, and a fallback worth reading.** The agent's
own `session_info_update` title was already used and already free — it comes
with work the agent is doing anyway. What was poor was the fallback for agents
that send none: the first 60 characters of the first message, markdown and
"can you please" included. `title.ts` now takes the first prose line, drops
list markers, headings, fences and a leading pleasantry, and truncates that.

**Summarising it ourselves was considered and rejected.** We are an ACP client
with no model, so a "name this chat" call means either spawning a second agent
subprocess to title a conversation or spending the user's own context window on
it. The tokens would be trivial; the machinery is not, and the second option
puts a housekeeping exchange in the transcript. Trimming the first line gets
most of the benefit for nothing.

**A closed session no longer appends.** Its agent exits a moment after
`close()` returns, and if the conversation had been resumed in that window the
two Sessions claimed the same `seq` — one INSERT failed and its log disagreed
with the disk a reconnecting browser replays from. This was the source of the
`UNIQUE constraint failed` lines the test suite had been printing all along.

**The stale-provider bug is fixed.** A provider is condemned only by an agent
that exits non-zero having never completed a turn; a crash after a successful
turn leaves a dead session and an untouched provider. Two sessions on one
provider, one killed, is now a test.

**Compaction landed, and it too was mis-scoped here.** This file said the
protocol "already reports" compaction status and we merely failed to surface it.
In fact agents are forbidden from sending compaction updates unless the client
advertises `session.compaction`, which we did not — so nothing was arriving. We
now advertise it and render the compaction as a seam in the transcript, with the
agent's own summary behind it. See
[PROTOCOL.md](PROTOCOL.md#compaction-has-to-be-asked-for-and-its-updates-are-patches).

**`elicitation/create` landed, and it is not what this file said it was.** The
roadmap described a multiple-choice question; ACP actually specifies a *form* —
a JSON Schema of primitive properties — plus a separate URL mode. We render the
form, advertise `form` alone, and decline anything else. See
[PROTOCOL.md](PROTOCOL.md#elicitation-is-a-form-not-a-multiple-choice).

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

**ACP works as designed.** `initialize` against the real Claude Code adapter
returned `protocolVersion: 1`, `loadSession: true`, prompt capabilities and an
`authMethods` entry — the whole basis of the check ladder, confirmed. What the
spike learned about the protocol itself now lives in
[PROTOCOL.md](PROTOCOL.md).

**The stderr buffer paid for itself immediately.** The adapter failed
`session/new` with `-32603 "Query closed before response received"` — useless on
its own. stderr held the real cause: it refuses to run nested inside another
Claude Code session. Keep this diagnostic; it is not optional.

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
long stare at a spinner. Worth a per-provider override, or streaming rung
progress to the UI.

**The reason given for the generous timeout was wrong.** It said `npx` may
download an adapter on first run — but `npx -y` re-resolves on *every* spawn,
which measured 81s against 0.5s for the same binary, so the seeded Claude Code
provider failed the ladder every time on a warm cache. The seeds now name
binaries; see the spawning gotcha.

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

`session/set_model` is not in the v1 method registry, and agents emit both
config dialects at once. Both are written up in
[PROTOCOL.md](PROTOCOL.md#findings); they shaped the fallback and the merge in
`configOptions.ts`.

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

- [x] FTS5 search across all sessions, with highlighted snippets
- [x] `AGENT_NOT_FOUND` offers per-platform install commands and a manual path
      field, rather than only naming the paths tried
- [x] Context-window usage indicator (from `usage_update`)
- [x] Rename conversations; a manual name locks against the agent renaming it
- [x] Live status per conversation in the sidebar (working / needs input /
      ready / detached), pushed rather than polled
- [x] Group consecutive tool calls and thinking into one collapsed work row
      ("Ran 3 tools"), expandable to the individual cards
- [x] Remember a default model (and mode) per provider, applied to each new
      session. Stored against the provider and re-applied after `session/new` —
      still never a hardcoded list, just a remembered choice.
- [x] An icon: an original mark (a browser window with a terminal prompt in
      it), avoiding the trademark problem a Kiro/Chrome mashup would have
- [x] Archive conversations: hidden from the sidebar without deleting the log,
      with an "Archived" toggle to see them and restore any of them
- [x] Theme control on the Setup page: light / dark / follow system
- [x] Keyboard shortcuts, session switching
- [x] Image paste and drag-drop, when the agent advertises `promptCapabilities.image`
- [x] Export a conversation to markdown

---

## Deliberately out of scope for now

- LAN / remote / tunnelled access, and therefore auth. Localhost only.
- Multi-user anything.
- Writing our own agent. We are a client.
- Windows as a first-class target — best-effort, fixed if it is cheap.
