# Gotchas

Every entry here cost someone time. They are grouped so the list stays
navigable as it grows — it only ever grows.

Read this before touching the area it covers. [AGENTS.md](../AGENTS.md) has the
rules; this file has the specific traps behind several of them.

**Adding one:** when you fix a bug, add the case to the test suite *and* the
trap here, in the group it belongs to. A fix without a note invites the same
bug from the next person, who has no reason to know.

## Protocol

- **Models are only known after `session/new`.** So the setup check, which
  runs one, keeps what the agent advertised (`ProviderCheckResult.options`,
  normalised) and the New chat, Schedule and Room forms offer pickers from
  that. It is a cache: it can lag the agent, so a value it no longer offers
  is skipped when the session starts, never refused up front. Do not "fix"
  any of this by hardcoding a list.
- **Agents emit both config dialects at once**, sometimes with different
  settings in each. Merge `configOptions` with the legacy `models`/`modes`
  rather than letting one hide the other.
- **`session/cancel` is a notification, not a request.** Awaiting a reply makes
  Stop hang forever and appear to do nothing.
- **A `sessionCapabilities` sub-capability is an object, not a boolean.** Absent
  or `null` means unsupported; `{}` means supported. Testing it for truthiness
  reads correctly today and breaks on `{ "list": null }`, which the schema
  explicitly allows. Test for presence — `advertisesSessionList` does.
- **Listing sessions and loading one are different capabilities.**
  `sessionCapabilities.list` gates `session/list`, but `session/load` is still
  gated by the top-level `loadSession`, so an agent can offer a conversation it
  cannot reopen. Check both before showing the user something clickable.
- **`session/load`'s replay is only redundant when we already logged it.** An
  ordinary resume must discard it; a conversation adopted from the agent's own
  CLI must keep it, or the transcript starts at the moment we attached. Getting
  this the wrong way round either duplicates a conversation or loses one.
- **Only advertise a capability you implement.** We claimed
  `fs.readTextFile`/`fs.writeTextFile` for months without handlers; agents check
  the capability and then call, so their file operations failed with a bare
  "method not found". Adding to `clientCapabilities` is a promise.
- **Probe an optional extension once, then stop.** `_kiro.dev/commands/options`
  is an ACP extension, not the standard; a failed call marks it unsupported for
  that session rather than being retried on every keystroke.
- **Not every agent setting is a `configOption`.** Slash commands are the other
  half: advertised by `available_commands_update` and run as ordinary prompt
  text. Kiro exposes reasoning effort only that way, so a missing picker does
  not mean a missing feature.
- **An update you never advertised is an update you never receive.** Compaction
  updates are gated on `clientCapabilities.session.compaction`; without it the
  agent is forbidden from sending them, and the absence looks exactly like an
  agent that does not compact. Check the capability before concluding an agent
  does not do something.
- **`compaction_update` is an upsert, and its fields are patches.** Omitting
  `summary` means "leave it alone", `null` and `[]` both clear it. The terminal
  `completed` update usually omits it, so treating omission as "clear" wipes the
  summary at the moment the compaction succeeds.
- **`elicitation/create` is a form, not a multiple choice**, and it has a
  second mode that sends the user to a URL. Advertise the modes you actually
  render — we claim `form` alone and decline the rest — and remember that
  `decline` is a legitimate answer, so declining is never a reason to throw.
- **`session/load` returns `modes` and `configOptions` too**, exactly as
  `session/new` does. Discarding its response leaves a resumed conversation
  with no pickers at all.

## Spawning agents

- **Never seed a provider as `npx -y <package>`.** `-y` means "do not prompt",
  not "use the cache": npx re-resolves the package against the registry on
  every spawn. Measured on a dev machine, `npx -y @agentclientprotocol/claude-agent-acp`
  took **81 seconds** to answer `initialize`, against **0.5 seconds** for the
  same adapter's binary — so the check died at the 60s handshake timeout, every
  time, with a warm cache.

  The damage is not the delay, it is the diagnosis. `AGENT_HANDSHAKE_TIMEOUT`
  says the command may not be an ACP server, which sends you to inspect a
  perfectly healthy agent. Seed the binary: a missing one fails at `resolve` in
  7ms with an install hint and a path field, which is the error you want.

## Concurrency

All of these were real races, found the hard way.

- **A queued message's promise belongs to that message.** `prompt()` used to
  return at once whenever a turn was already running. A caller awaiting it —
  the scheduler, a room — took that as "sent and finished": a scheduled run
  with an opening message recorded *ok* having sent nothing, and a room read
  the *running* turn's text as the reply. Each queue entry now resolves when
  its own turn ends, and the drain loop is single-flight, because `busy` drops
  to false between turns and a `prompt()` landing in that gap started a second
  loop.
- **A turn the agent did not end must still end.** A crash mid-turn, or a
  `close()` during one, left the transcript stopped mid-answer with an
  unmatched `turn_start` — and anything reading the log for "did it finish"
  got no answer. `runTurn`'s catch appends a `turn_end` with a reason of our
  own (`error`), and `close()` writes one (`closed`) *before* shutting the log,
  since the catch fires only after. Readers must not treat every `turn_end`
  as success: the scheduler keeps scanning past those two reasons for the
  error before them.
- **Single-flight anything that awaits before registering itself.** `resume`
  awaits a handshake, so two calls arriving in that window each built a Session
  for the same conversation — both appending from the same seq, and each with
  its own agent process.
- **Nothing may `await` between "the person pressed Enter" and the queue
  push.** Resolving `@` mentions before enqueueing made `prompt()` async at
  the front, so `summary().queued` was empty right after a call and two
  prompts could land in the queue in the wrong order. The entry is pushed at
  once with the resolution as a promise, awaited when the drain reaches it.
- **"Nothing sent since" must be decided before this message is appended.**
  The handoff owed after a provider switch is found by scanning back from the
  end of the log for a `provider_switched` with no `user_message` after it.
  Checked after appending the message being sent, it found that message first
  and never sent the handoff. Order the read before the write when the read is
  about what came before.
- **Register a pending resolver before announcing the event that asks for it.**
  `append` notifies subscribers synchronously, so an answer arriving
  synchronously would find no pending entry and be dropped, blocking the agent
  forever. This is exactly how the permission race was found.
- **A closed session must stop appending.** `close()` returns immediately but
  the agent exits milliseconds later, and its exit handler appends. If the
  conversation has been resumed in the meantime — archive then reopen, or a
  reconnect arriving as the old agent dies — the new Session read `lastSeq`
  before that append landed and has claimed the same seq. One INSERT then fails
  and *that* session's in-memory log disagrees with the disk the browser
  replays from. Flush buffered text before setting the flag, or the last words
  go missing instead.
- **A socket's subscriptions replace, they do not accumulate.** `subscribe`
  used to push onto a list that only emptied when the connection closed, so a
  socket that had viewed two conversations received both. It was invisible only
  because switching used to redial the socket; the moment the connection
  survives a switch, a background turn streams its events into whichever
  transcript is open, interleaved by `seq` and indistinguishable from that
  conversation's own output. The client filters incoming batches by `sessionId`
  as a second line of defence, since a batch can already be in flight when the
  switch happens.
- **Every map of "requests waiting on a human" must be drained on *both* ways
  out** — a crashed agent and a deliberate `close()`. Elicitations are the
  second such map after permissions, which is why `releasePending()` exists
  rather than two more loops copied into each path. A promise nobody will
  resolve turns a close into a hang.
- **Cancelling must also answer what the agent is waiting on.** `cancel()`
  sent `session/cancel` and nothing else, but an agent blocked on a permission
  or elicitation request is waiting on *our reply*, not on the notification —
  so a room that timed out a stuck participant and cancelled it still had a
  stuck participant. The spec is explicit: on cancel the client MUST answer
  pending `session/request_permission` with `cancelled`. `sendCancel()` drains
  both maps first, on the Stop path and the interrupt path alike.
- **An unattended turn gets a cap, and the loop that owns it cannot be
  started twice.** A room turn had no timeout, so a participant asking
  permission that nobody in a room answers held the round for ever (invariant
  10); now `withTimeout` cuts it off, cancels the agent, and stops the room
  with the name in the message. Separately, two room paths assumed they could
  start the round loop afresh while it was still running — `round()` returns
  at once on `running`, so cut-in kept the old budget and a hold released
  before the turn ended (or during the pause after it) left the room idle
  until Continue. Anything the user does mid-round now tells the *running*
  loop what to do (`restart` for a fresh budget; status back to `running` for
  a released hold) instead of starting another.
- **A timer's due check must not `await` the work it fires.** `tick` awaited
  each due schedule's run in series, so one long run delayed every other
  schedule's check by up to the run cap. Fire and forget; `run` never throws
  and registers itself synchronously, so the next tick cannot double it. The
  same tick wrote a `skipped` row every minute a 1-minute schedule was due
  while its run was still going — the overlap is recorded once.

## Processes

- **A superseded agent's exit is not the session's.** `switchProvider` kills
  the old process after the new one is up; its `exited` handler then ran and
  marked the session dead, dropped the queue and released the new agent's
  pending prompts. The handler checks `this.proc === proc` first. Any handler
  bound to a process a session can outlive needs the same check.

- **Killing a shell does not kill its children.** Kill the process group
  (`process.kill(-pid, …)`), SIGTERM then SIGKILL after a grace period, or
  orphans survive and the terminal appears hung.
- **Identify a process by its start time, not its command line.** A shell may
  exec-replace itself (`sh -c "sleep 30"` becomes `sleep 30` under bash but not
  dash), so command text is unreliable; start time survives an exec and changes
  on PID reuse.
- **Reap orphaned processes once at startup, never per session** — per-session
  reaping kills processes belonging to sessions that are still alive.
- **Dropping a session is not closing it.** When an agent died, `SessionManager`
  deleted it from `live` and stopped there, so its `TerminalRegistry` was never
  released — the commands that agent had started were now referenced by nothing
  at all, and outlived both the session and the server. "Released on session
  close" in invariant 6 has to mean *every* way out, and the crash path is the
  one nobody tests by hand, because it looks fine: the conversation disappears
  from the sidebar exactly as it should.
- **Open several, fail on one: close the ones already open.** A room spawns
  a participant per provider before it exists in the store; when the third
  failed, the first two were live under a room id nothing would ever look up
  — killable at shutdown, leaked until then. Any loop that opens resources in
  turn needs the catch that detaches what it got.
- **Windows cannot reap, and now says so.** The ledger's identity check is a
  `ps` start time; there is no `ps` on Windows, so every entry recorded a blank
  and `reapOrphans` declined them all — a silent no-op that looked like it
  worked. It logs once at startup that reaping is unsupported there instead.
  A PowerShell `Get-Process` start time would make it work, and is a small
  change for whoever has a Windows machine to run it on.
- **Never log `env`** when logging a spawn.
- **One session's crash is not a verdict on its provider.** Marking a provider
  stale removes it from the new-chat list until someone re-runs the check, so it
  needs evidence about the *provider* — not about one conversation. An agent
  that completed a turn has already proved the binary, args and login are fine;
  crashing later says the session died, and the session running beside it on the
  same provider says so too. Only an agent that exits non-zero having never
  answered is real evidence. Per-session evidence driving a global verdict is a
  recurring shape here — ask what happens with two conversations open.

## Security

- **Check `Host`, not only `Origin`.** Same-origin GETs send no `Origin`, so a
  page on a DNS-rebound name that resolves to `127.0.0.1` passed the check by
  omission and could read every GET route — transcripts, schedule prompts and
  cwds, exports. The `Host` header is what such a page cannot make look like
  ours; it has to be `localhost` or `127.0.0.1` on our port.
- **Auto-approve takes `allow_once`, never `allow_always`.** Picking the first
  option whose kind started with `allow` let an unattended run grant the agent
  a standing, agent-side permission that outlives the run and that nobody saw.
- **A convenience entry in the Origin allowlist is a permanent hole.**
  `http://localhost:5173` was in the list unconditionally so the Vite dev server
  could talk to us — but 5173 is Vite's *default*, so in a built install that
  entry does not mean "our dev server", it means any project the user happens to
  be running. `PATCH /api/providers/:id` sets the command we spawn, so a page on
  an unrelated origin could choose what runs on the machine. Dev-only trust
  needs a dev-only signal: `KIROCHROME_DEV=1`, set by `scripts/dev.mjs` and
  nothing else.
- **Anything stored from the browser and served back to it needs its
  `Content-Type` re-checked.** An attachment's `mime` was validated as "a
  string" and echoed straight back as the header, which made `text/html` a way
  to serve script from our own origin — and from there, same-origin access to
  the whole API. Validate at the boundary, re-check on the way out because old
  rows predate the check, and send `nosniff`. SVG counts as script here: it is a
  document, not an inert raster.

## Storage

- **A column added to a `CREATE TABLE IF NOT EXISTS` is not added to the
  table that exists.** Rooms gained `rules`; the create statement was updated
  and every database made before it kept the old shape, so opening one failed
  on the first `SELECT rules`. Each new column needs its own
  `PRAGMA table_info` check and `ALTER TABLE ADD COLUMN` beside the others
  in `Store`'s constructor — that is the migration mechanism, and there is no
  other.

- **`ON CONFLICT DO UPDATE` lists its columns; a new mutable field is not in
  it.** `upsertSession` updated title and status but not `provider_id`, so a
  switched conversation reopened on its old provider after a restart. When a
  column stops being write-once, add it to the update list — the INSERT half
  will not tell you.

- **A lenient read is only safe while nothing writes back from it.**
  `loadConfig` skips a malformed provider so the setup page still loads;
  `updateProvider` then wrote the validated list back, so correcting one
  provider's path silently deleted a hand-edited neighbour that had a typo in
  it. Saves patch the file *as written*, invalid entries included.
- **A metadata write must not decide status.** `persistMeta` hardcoded
  `status: "active"`, so an agent-sent title — or any other metadata update —
  put an archived conversation back in the sidebar. It preserves whatever the
  row has.
- **A file stream needs an `error` listener.** `createReadStream(...).pipe(res)`
  with none is fatal to the process on any read error, and a static asset that
  vanishes between `existsSync` and the read is enough to take every running
  turn down.
- **Do not write a database row per streamed token.** Coalesce deltas on a
  ~250ms flush.
- **`node:sqlite` warns on Node 22**, stable on 24. Pin via `.nvmrc`. Do not
  swap it for a native module to silence the warning.
- **`CREATE TABLE IF NOT EXISTS` never adds a column.** A table created by an
  earlier build keeps its old shape, and the next INSERT fails with SQLite's
  unhelpful "SQL logic error". Every column added after a table first shipped
  needs its own `ALTER TABLE` in `Store.migrate()`, guarded by
  `PRAGMA table_info` — the way `title_locked` and `auto_approve` are.

## Browser

- **An omitted `oldText` is not an empty one.** ACP's diff `oldText` is
  optional; coercing absence to `""` made the Changes pane label every write
  whose before-text the agent left out as a *new* file. Absent stays `null`:
  nothing to diff against, and the file keeps "modified".
- **`white-space: pre-wrap` must not reach markdown rows.** It renders the
  newlines between block elements literally, double-spacing every paragraph.
- **A failed re-check request is not a passing check.** The setup card kept its
  stored "Ready" pill while a banner said the re-check had been refused, because
  the request's failure went to page-level state and the card's result was
  never touched. A request that did not run leaves the provider *unverified* —
  the stored result is still shown as the last check that did run, but it is
  not presented as current, and it does not count toward "N of M ready".
- **Vite must not be allowed to drift ports.** The server trusts exactly
  `5173` in dev mode. Vite's default when that port is busy — a dev server left
  running in another worktree, say — is to start on `5174` and carry on, so
  the page loads fine and then every request is a 403, while the runner still
  prints 5173. `strictPort: true` makes it fail to start instead, which is the
  honest outcome. If you do see `ORIGIN_REJECTED`, the error names the origin
  it refused and the ones it would take; compare them before theorising.
- **The WebSocket lives at `/ws`.** At `/` it collides with Vite's hot-reload
  socket, and dev mode silently never connects.
- **State that changes per keystroke does not belong in the transcript's
  component.** `draft` was `useState` in `Chat`, which also rendered every row,
  so one character re-rendered up to 60 rows and each prose row re-parsed its
  markdown and re-highlighted its code blocks. `buildRows` being memoized did
  not help — the fold was not re-running, the *rendering* was. The composer is
  now its own component for that reason, and `Message` and `MarkdownBody` are
  memoized as a backstop. Before adding fast-changing state, ask what else is
  rendered by the component you are putting it in.
- **A `key` on the component that owns the socket rebuilds the socket.** `Chat`
  calls `useChat`, so `key={sessionId}` meant every switch between conversations
  closed the connection and redialled one — a visible pause before anything
  could even be requested, for a server that was happy to serve the switch over
  the connection already open. React keys are for resetting state; check what
  else the component owns before reaching for one. What actually wanted
  resetting was the composer's draft, which is keyed instead.
- **Smooth scrolling is for output arriving while you watch.** Used on arrival
  it renders the top of the backlog and then animates all the way down, which
  reads as slowness rather than polish. Jump for the first scroll into a
  conversation — from `useLayoutEffect`, so the top is never painted — and go
  smooth only once the reader is following live output.

## Untrusted input

- **A Node `ENOENT` passes `isKcError`.** It has a `code` and a `message`,
  which is all the shared guard checks, so a `catch` that re-throws "ours"
  and wraps the rest passed a bare filesystem error through untyped. `files.ts`
  checks the code against the closed list instead. Anywhere that catches more
  filesystem errors than protocol ones should do the same.
- **Serve raw bytes from a chosen directory as a unique origin.** The Files
  pane's raw route is on our origin, and a cloned repository can hold an HTML
  or SVG file with a script in it; navigated to directly, it would run with
  access to our API. Only images and PDFs go out raw, with `nosniff` and a
  `Content-Security-Policy: sandbox`; SVG is XML and is shown as text.

- **Text from one agent is untrusted input to the next.** Room prompts joined
  messages as `[Name] text`, so a reply containing `\n\n[You] …` put words in
  the user's mouth for every agent after it. Each message is now quoted
  between `<message from="…">` tags the prompt says only the room writes, and
  a `<message` or `</message` inside a reply is defanged (`&lt;`) rather than
  dropped. This is prompting, not sandboxing: it makes impersonation
  something the model has to be talked into, not something the prompt's own
  format hands it.

- **Validate what an agent hands the terminal.** `outputByteLimit` of `0` or a
  negative number silently emptied the buffer, which reads to the agent as a
  command with no output; the value was wrong and nothing said so. Refuse it
  with a typed error, the only answer that lets the agent fix its request.
  The same goes for a status literal on `PATCH /api/schedules/:id` — any string
  used to be stored — and for an agent-supplied diff path dropped into the
  export's HTML.
- **`typeof x === "number"` is not "a number you can use".** `JSON.parse`
  happily turns `1e999` into `Infinity`, and both it and `NaN` survive
  arithmetic, so `{"type":"move_queued","from":1e999}` passes a naive check and
  reaches an array index. Every numeric field in a validator uses
  `Number.isFinite`.
- **Writing the config back erases what loading it dropped.** `loadConfig`
  skips an invalid provider entry, and `updateProvider` writes the *loaded*
  config — so editing any provider from the setup page silently removes the
  broken entry from `config.json`. The file converging on something valid is
  the intended behaviour, but the user's typo ends up deleted rather than
  fixed, which is why the drop is warned about on stderr instead of passed over
  in silence.

## Working on the repo

- **A test file has a 45-second cap, and the mock's "long" turn is ten of
  them.** `session.test.mjs` grew past the cap as features were added, and
  failed only under the full run — alone it was borderline, so it passed
  locally and on a fast CI runner. Split a suite when it nears thirty seconds
  rather than raising the cap: `queue.test.mjs` holds the ones that ride that
  turn, `sessionFeatures.test.mjs` the newer behaviours.
- **A rebase can leave a CSS rule unclosed and nothing will tell you.** Two
  branches added rules at the same spot in `styles.css`; the merge kept one
  opening brace and the other's body, and the stylesheet parsed with every
  rule after that point silently swallowed. There is no CSS typecheck. After
  a rebase that touched `styles.css`, look at the merged region, or open the
  page.

- **A tested web module names its sibling imports `.ts`, not `.js`.** The
  unit suite runs `src/*.ts` under Node's type stripping, which does not
  rewrite `.js` specifiers to `.ts`, so `import "./diff.js"` from a module the
  tests load fails with module-not-found. `allowImportingTsExtensions` is on
  for the web package for exactly this; Vite resolves either. `changes.ts` is
  the example. (The server suite sidesteps it by running against `dist`.)

- **`git branch --merged main` is useless here.** We rebase-merge, which
  rewrites the commits, so a merged branch is never an ancestor of `main` and
  the command lists nothing — branches accumulate locally looking unmerged, and
  the pile is indistinguishable from work still in flight. Ask GitHub instead
  (`gh pr view <branch> --json state`), which is what `npm run wt -- prune` does.
- **Do not run `gh pr merge` from inside a worktree.** It updates your local
  `main` after merging, and cannot: the main checkout holds that branch, so it
  fails with `'main' is already used by worktree at …`. The merge on GitHub has
  already happened by then, so you are left with a merged PR, an error, and no
  cleanup. `cd` to the main checkout and merge from there.
- **A branch deleted on the remote still shows in `git branch -r`.** The
  remote-tracking ref is a local cache; `gh pr merge --delete-branch` cannot
  touch it. `git fetch --prune` clears it, and `wt prune` runs that for you.
- **Worktrees belong outside the repo directory.** Nested under it, the npm
  workspace glob, `tsc -b` and vite's watcher all find a second copy of the
  tree and behave in ways that take a while to attribute.
- **A worktree has its own `node_modules`, and `spike/` needs its own install.**
  A fresh worktree looks broken in the same way a fresh clone does: the server
  suite spawns the mock agent, which needs the ACP SDK that lives in `spike/`.
- **Two dev servers cannot run at once.** They share ports 4711 and 5173 *and*
  one sqlite database, so the second one to start fails on the port if you are
  lucky and interleaves conversations in one database if you are not.
- **Driving KiroChrome from inside KiroChrome: `git pull` kills the agent doing
  the work.** If the agent you are talking to was spawned by `npm run dev` in
  this checkout, any git operation that rewrites `packages/*/src/*.ts` — pull,
  rebase, checkout, `wt prune` — makes `tsc -b -w` rebuild `dist`, which makes
  `node --watch` restart the server, which kills its agent process group on the
  way out. The agent dies with SIGKILL (exit 137) mid-command, and because the
  server owns the turn the browser just sees the conversation detach.
  Everything is recoverable — the log is on disk and **Resume conversation**
  re-attaches — but a command that was halfway through a push or a rebase is
  not, so you re-run it and reason about a repo in an unknown state.

  This is not a bug: it is invariant 4 working, plus "a server restart detaches
  running agents" from the README, meeting the case nobody planned for. Fixes,
  cheapest first: run the app you are chatting through with `npm start` rather
  than `npm run dev` so nothing watches; or serve it from a worktree you never
  touch; or leave the main checkout's syncing to a moment when you are not
  mid-conversation. Operations that only move refs — `git fetch`, `git push`,
  `gh pr merge` — are safe, because they do not write to the working tree.
