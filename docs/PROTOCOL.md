# ACP notes

What we implement, and everything about the protocol we have learned by running
it. The spec is at <https://agentclientprotocol.com> — when this file and the
spec disagree, the spec wins and this file is a bug.

These findings were scattered through the phase notes in [PLAN.md](PLAN.md).
They are collected here because they are facts about ACP that outlive the phase
that discovered them.

**Protocol version: 1.** SDK: `@agentclientprotocol/sdk`, pinned exact.
A mismatch fails the check ladder at the `version` rung with
`AGENT_PROTOCOL_MISMATCH` rather than being tolerated.

## Our side of the wire

We play the **client** role — normally an editor, here a web server.

We advertise, in `initialize`:

```jsonc
{
  "fs": { "readTextFile": true, "writeTextFile": true },
  "terminal": true,
  "elicitation": { "form": {} }   // form mode only — see below
}
```

**Advertising is a promise.** Each of these has a handler, and adding another
capability without one breaks agents in a way that looks like an agent bug:
they check the capability, call the method, and get "method not found".

| We handle | Implemented in |
|---|---|
| `session/update` (notification) | `session.ts` — folded into the event log |
| `session/request_permission` | `session.ts` — held open until a human answers |
| `elicitation/create` | `session.ts` + `elicitation.ts` — held open like a permission |
| `fs/read_text_file`, `fs/write_text_file` | `fs.ts` |
| `terminal/create`, `output`, `wait_for_exit`, `kill`, `release` | `terminals.ts` |

We call `initialize`, `authenticate`, `session/new`, `session/list`,
`session/load`, `session/prompt`, `session/cancel`,
`session/set_config_option` (with a per-kind fallback), and — once per session,
optionally — `_kiro.dev/commands/options`.

## Findings

### Both config dialects arrive at once

Newer ACP generalises model and mode selection into `configOptions`; the older
API had `availableModels` and a `modes` state. Agents emit **both**, and not
always with the same settings in each — the mock exposed this by advertising a
model in one and a mode in the other. We merge rather than letting either hide
the other. See `configOptions.ts`.

### `session/set_model` is not in the v1 method registry

Kiro's docs still list it, but model selection moved to
`session/set_config_option`. A config change therefore tries the standard
method and falls back to the per-kind one, rather than guessing the dialect
from the `session/new` response.

### `session/load` replays the whole conversation

The agent re-sends its entire history as `session/update` notifications
*before* answering the load request. Our event log already holds all of it, so
appending would duplicate the transcript. We suppress the replay; verified at
0 duplicated rows.

It also returns `modes` and `configOptions`, exactly as `session/new` does.
Discarding the response leaves a resumed conversation with no pickers.

### `session/list` is real v1, and PLAN.md was nearly right about it

Checked before building anything, because the roadmap has already been wrong
twice this way. It holds up, with two corrections.

**The method exists in stable v1.** `session/list` is in the v1 schema
(`spike/node_modules/@agentclientprotocol/sdk/schema/schema.json`) and its
`ListSessionsRequest` / `ListSessionsResponse` / `SessionInfo` definitions carry
no stability warning. That matters because `session/fork` — the next roadmap
item — *is* marked in the same file:

> **UNSTABLE** — This capability is not part of the spec yet, and may be removed
> or changed at any point.

So the two are not equivalent bets, even though PLAN.md lists them together.
`list`, `delete`, `resume`, `close` and `additionalDirectories` are stable;
`fork` alone is unstable.

**`sessionCapabilities` sits inside `agentCapabilities`**, in the `initialize`
response — not at the top level. Each sub-capability is an **object**, not a
boolean: absent or `null` means unsupported, and `{}` means supported. Checking
it for truthiness would work by accident today and break the moment an agent
sends `{ "list": null }`, which the schema explicitly allows. Hence
`advertisesSessionList` in `shared/providers.ts`.

**Loading is still gated separately.** The schema is explicit:

> Note: `session/load` is still handled by the top-level `load_session`
> capability. This will be unified in future versions of the protocol.

So an agent can advertise `sessionCapabilities.list` and *not* `loadSession` —
listable conversations that cannot be opened. That is a real state with its own
error code, `AGENT_CANNOT_ADOPT`, rather than a confusing `SESSION_NOT_LIVE`
about a conversation "restored from disk".

The request takes optional `cwd` and `cursor`; the response is `sessions` plus
an optional opaque `nextCursor`. `SessionInfo` requires only `sessionId` and
`cwd` — `title` and `updatedAt` are nullable, so a listed conversation may have
no name and no date. The array is marked skip-invalid-items, so one malformed
entry must not cost the user the rest of the list; `agentSessions.ts` narrows
each entry and drops only the bad ones.

The intended flow is exactly what we do, per the spec's own summary: list,
let the user choose, then `session/load` with the chosen `sessionId`.

### An adopted conversation is the one case where the replay is kept

The finding above says we suppress `session/load`'s replay. That is right for a
conversation we have logged, and wrong for one the agent owns.

For a conversation started in the agent's own CLI, our log is empty — the
agent's replay is the only transcript in existence as far as KiroChrome is
concerned. So `Session.adopt` keeps it, and `Session.resume` still discards it.
Capturing is still append-only (invariant 2): they are INSERTs into a brand new
conversation. It happens exactly once, because adoption mints a new KiroChrome
session id and *every* later reopen goes through `resume` — so the transcript
cannot be duplicated by reopening, and the suite proves it.

Keeping it in the browser instead was the alternative and it breaks invariant 3:
the history would vanish on refresh.

Two consequences worth knowing:

- **What the user said arrives as `user_message_chunk`**, not as one of our
  `user_message` events, because it is the agent replaying both sides. Without
  handling it, half an adopted conversation renders as an unnamed note.
- **The replay is the agent's record, not ours.** It may be shorter than the
  real conversation and carries none of the tool output we would have logged.
  An `adopted` event marks the seam, so the transcript says where the agent's
  history ends and ours begins rather than implying we watched it happen.

### `session/cancel` is a notification

There is no reply. Awaiting one makes Stop hang forever.

### Auth is a real rung, not a formality

Agents advertise `authMethods` in the `initialize` response and return JSON-RPC
**`-32000`** if the client never calls `authenticate`. Skipping it is a known
way to break ACP clients. We map a `-32000` seen at `session/new` back to the
`authenticate` rung, so the user is told what to act on rather than seeing a
session failure.

### Streaming shapes

A turn streams `session/update` notifications and terminates with a
`stopReason`. Four kinds get their own event type — `agent_message_chunk`,
`tool_call`, `tool_call_update`, `session_info_update` — plus
`available_commands_update`, which updates the command catalogue.

**Everything else is appended raw as `agent_update`.** That is deliberate: an
update kind we do not recognise is still recorded, so the log stays complete and
a later reader can derive from it. `usage_update` works exactly this way — the
context meter derives from raw events rather than a field we parse out.

A turn emits thousands of message chunks; they are coalesced on a ~250ms flush
before they reach the database.

### Slash commands are the other half of configuration

Commands are advertised by `available_commands_update` and run by sending their
text as an **ordinary prompt** — there is no dedicated method and nothing
agent-specific about it.

This is how Kiro's reasoning effort is reachable: `/effort low|medium|high|xhigh|max`.
It is not a `configOption`, so it never appears in a picker. A missing picker
does not mean a missing feature. Kiro also persists the choice in
`~/.kiro/settings/cli.json`, where `chat.modelDefaults` sets a per-model default
independently of any client.

### Elicitation is a form, not a multiple choice

The roadmap assumed `elicitation/create` was "the agent asks a multiple-choice
question and the user clicks an answer". It is more than that. The request
carries a **mode**:

- **`form`** — a `requestedSchema`, which is a JSON Schema of *primitive*
  properties: string, number, integer, boolean, and an array of enum values for
  multi-select. Strings carry choices in one of two dialects, `enum` (plain
  values) or `oneOf` (titled `{const, title, description}` options); multi-select
  spells the same two `enum` and `anyOf`. So a multiple choice is one shape a
  form can take, not the whole feature.
- **`url`** — send the user to a URL and wait. A different interaction
  altogether, mostly for auth.

The reply is `{action: "accept" | "decline" | "cancel"}`, with `content` keyed
by property name on accept. Declining is a first-class answer, not an error.

**We advertise `form` only, and answer `decline` to anything else.** Invariant
12 cuts both ways: advertising a mode obliges us to render it, and URL mode
sends the user out to a page a chat UI has no part in.

The schema is flattened into typed fields **on the server**
(`elicitation.ts`), so nothing in the browser interprets JSON Schema. A
required property whose type we cannot render makes the whole form
unsupported — we decline rather than return content that does not satisfy the
schema the agent asked for.

### Compaction has to be asked for, and its updates are patches

Two things the roadmap's "surface the status the protocol already reports" got
wrong.

**It reports nothing unless you ask.** Agents MUST NOT send `compaction_update`
or `compaction_summary_chunk` unless the client advertised
`clientCapabilities.session.compaction`. We were not advertising it, so those
updates were never arriving at all — there was nothing to surface. We now send
`session: { compaction: {} }`, which the schema describes as advertising the
complete compaction contract, meaning both update types.

**Updates are upserts with patch semantics.** A compaction is addressed by
`compactionId`: the first update fixes its position in the timeline and later
ones patch that same entity in place. For `summary` and `error`, **omitting a
field leaves the stored value unchanged**, `null` clears it, and `summary: []`
also clears it. So the terminal `completed` update usually carries no summary at
all, and treating an omission as "clear" wipes the summary exactly when the
compaction finishes. Summary text also arrives as `compaction_summary_chunk`
appends between the first update and the terminal one.

Because the first update fixes a timeline position, compaction is a transcript
event rather than session state — it renders as a seam at the point history was
replaced, not as a header indicator.

**It is marked UNSTABLE** in the schema, unlike the rest of what we implement.
Accepted deliberately: the blast radius is one row, and if the capability is
withdrawn agents simply stop sending and the row stops appearing. That is a
different bet from building on [ACP v2](#steering-and-acp-v2), which changes the
turn lifecycle underneath everything.

### Steering and ACP v2

**v1 has no way to inject a message into a running turn.** The only mid-turn
traffic is `session/request_permission` responses and `session/cancel`; a turn
runs until a `stopReason`. Anything called "steering" on v1 is really
cancel-then-re-prompt, and `session/cancel` must produce the `cancelled` stop
reason, with the client marking unfinished tool calls `cancelled` too.

[ACP v2](https://agentclientprotocol.com/announcements/acp-v2-draft) changes
this at the root: `session/update` may flow at any point in a session, a prompt
response becomes an acknowledgement rather than the end of the turn, and agents
signal idle. That is exactly what queueing and steering need.

**It is Draft.** The spec's own advice is to gate v2 behind version negotiation
and not ship on it before it stabilises, since v1-only peers will be common for
a long time. We negotiate v1 strictly and fail the `version` rung on anything
else — a decision to revisit when v2 settles, not an oversight.

### Agent extensions

`_kiro.dev/commands/options` is a Kiro extension supplying argument suggestions
for a command. It is probed **once** per session; a failure marks it
unsupported for that session rather than being retried on every keystroke.

Extensions are the one place per-agent code is legitimate. Keep them behind a
capability probe and make sure the standard path still works when the probe
fails — see invariant 5 in [AGENTS.md](../AGENTS.md).

### The SDK's client API

`client({name})` → `.onNotification("session/update")` /
`.onRequest("session/request_permission")` → `connect(stream)`, or
`connectWith(stream, fn)` when the connection should be torn down as soon as
`fn` returns — which is what the check ladder wants and a live session does not.
`ndJsonStream` adapts the child's stdio.

### Capabilities we are not using yet

Advertised by agents, unimplemented by us, and roadmapped in [PLAN.md](PLAN.md):
`session/fork` (unstable), `session/delete`, `session/resume`, `session/close`.

Deliberately not implementing: `nes/*` (next edit suggestions) and
`document/did*`. Both assume an editor with a cursor and a focused buffer.

## Reading the wire

`KIROCHROME_TRACE=1` writes every JSON-RPC frame, both directions, to JSONL in
the data directory. Use it before theorising about what an agent sent.

To probe an agent without the UI at all, see [PROVIDERS.md](PROVIDERS.md).
