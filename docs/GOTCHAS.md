# Gotchas

Every entry here cost someone time. They are grouped so the list stays
navigable as it grows — it only ever grows.

Read this before touching the area it covers. [AGENTS.md](../AGENTS.md) has the
rules; this file has the specific traps behind several of them.

**Adding one:** when you fix a bug, add the case to the test suite *and* the
trap here, in the group it belongs to. A fix without a note invites the same
bug from the next person, who has no reason to know.

## Protocol

- **Models are only known after `session/new`.** The composer's pickers cannot
  be populated before a session exists, which is why a session is created as
  soon as a provider is chosen. Do not "fix" this by hardcoding a list.
- **Agents emit both config dialects at once**, sometimes with different
  settings in each. Merge `configOptions` with the legacy `models`/`modes`
  rather than letting one hide the other.
- **`session/cancel` is a notification, not a request.** Awaiting a reply makes
  Stop hang forever and appear to do nothing.
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

## Concurrency

All of these were real races, found the hard way.

- **Single-flight anything that awaits before registering itself.** `resume`
  awaits a handshake, so two calls arriving in that window each built a Session
  for the same conversation — both appending from the same seq, and each with
  its own agent process.
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
- **Every map of "requests waiting on a human" must be drained on *both* ways
  out** — a crashed agent and a deliberate `close()`. Elicitations are the
  second such map after permissions, which is why `releasePending()` exists
  rather than two more loops copied into each path. A promise nobody will
  resolve turns a close into a hang.

## Processes

- **Killing a shell does not kill its children.** Kill the process group
  (`process.kill(-pid, …)`), SIGTERM then SIGKILL after a grace period, or
  orphans survive and the terminal appears hung.
- **Identify a process by its start time, not its command line.** A shell may
  exec-replace itself (`sh -c "sleep 30"` becomes `sleep 30` under bash but not
  dash), so command text is unreliable; start time survives an exec and changes
  on PID reuse.
- **Reap orphaned processes once at startup, never per session** — per-session
  reaping kills processes belonging to sessions that are still alive.
- **Never log `env`** when logging a spawn.
- **One session's crash is not a verdict on its provider.** Marking a provider
  stale removes it from the new-chat list until someone re-runs the check, so it
  needs evidence about the *provider* — not about one conversation. An agent
  that completed a turn has already proved the binary, args and login are fine;
  crashing later says the session died, and the session running beside it on the
  same provider says so too. Only an agent that exits non-zero having never
  answered is real evidence. Per-session evidence driving a global verdict is a
  recurring shape here — ask what happens with two conversations open.

## Storage

- **Do not write a database row per streamed token.** Coalesce deltas on a
  ~250ms flush.
- **`node:sqlite` warns on Node 22**, stable on 24. Pin via `.nvmrc`. Do not
  swap it for a native module to silence the warning.

## Browser

- **`white-space: pre-wrap` must not reach markdown rows.** It renders the
  newlines between block elements literally, double-spacing every paragraph.
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

## Working on the repo

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
  touch it. `git fetch --prune` clears it, and `wt done` runs that for you.
- **Worktrees belong outside the repo directory.** Nested under it, the npm
  workspace glob, `tsc -b` and vite's watcher all find a second copy of the
  tree and behave in ways that take a while to attribute.
- **A worktree has its own `node_modules`, and `spike/` needs its own install.**
  A fresh worktree looks broken in the same way a fresh clone does: the server
  suite spawns the mock agent, which needs the ACP SDK that lives in `spike/`.
- **Two dev servers cannot run at once.** They share ports 4711 and 5173 *and*
  one sqlite database, so the second one to start fails on the port if you are
  lucky and interleaves conversations in one database if you are not.
