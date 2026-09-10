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

Both of these were real races, found the hard way.

- **Single-flight anything that awaits before registering itself.** `resume`
  awaits a handshake, so two calls arriving in that window each built a Session
  for the same conversation — both appending from the same seq, and each with
  its own agent process.
- **Register a pending resolver before announcing the event that asks for it.**
  `append` notifies subscribers synchronously, so an answer arriving
  synchronously would find no pending entry and be dropped, blocking the agent
  forever. This is exactly how the permission race was found.
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
