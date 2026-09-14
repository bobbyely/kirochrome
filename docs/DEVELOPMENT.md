# Developing KiroChrome

How to run it from a checkout, work on it, and look under it when an agent
misbehaves. For the rules of the codebase see [AGENTS.md](../AGENTS.md).

## Running from a checkout

Requires **Node 22.5+** (for the built-in `node:sqlite`). See `.nvmrc`.

```bash
git clone https://github.com/bobbyely/kirochrome.git
cd kirochrome
npm install
npm start                 # builds everything, serves http://127.0.0.1:4711
```

Open <http://127.0.0.1:4711>, press **Check** on a provider, and once it passes,
**New chat**.

If the agent keeps conversations of its own — Claude Code and Kiro both do — the
new-chat page offers to **browse** them, so a conversation you started in the
terminal can be continued in the browser. It says so where it matters: the
transcript above the seam is whatever the agent replays, and KiroChrome's own
log starts where you opened it.

## Development with hot reload

```bash
npm run dev
```

One command, three watchers: the UI hot-reloads on <http://127.0.0.1:5173>
without losing your place, and the server rebuilds and restarts on change.
Ctrl-C stops all of it.

Vite proxies `/api` and `/ws` through to the server on :4711, so use the 5173
URL — the 4711 one serves the last built bundle, not your edits.

A server restart detaches running agents. Conversations are persisted, so
reopening one and pressing **Resume conversation** picks it back up.

## Working on several features at once

Each change gets its own git worktree, beside the repo rather than inside it:

```bash
npm run wt -- new <topic>     # branch + ../kirochrome-worktrees/<topic> + install
git worktree list             # what is in flight
npm run wt -- prune           # remove everything merged (--yes to go ahead)
```

`prune` asks GitHub whether each PR was merged, because rebase-merging means
`git branch --merged` never says so. It refuses on uncommitted or unpushed work,
and prints what it would remove unless you pass `--yes`.

Everything in between is ordinary git and `gh`; see the pull request section of
[AGENTS.md](../AGENTS.md) for the sequence.

Only run one dev server at a time — worktrees share ports 4711 and 5173, and a
single database.

## On a new machine

`.git/config` does not travel with a clone, so set your commit identity before
your first commit — otherwise commits are attributed to whatever global identity
that machine has (a corporate one, on a work laptop):

```bash
git config user.name  "bobbyely"
git config user.email "robert.w.ely@gmail.com"
```

Verify with `git log -1 --format='%an <%ae>'` after committing. Getting it right
at commit time is the only fix that works: a `.mailmap` would canonicalise the
display for git's own tooling, but GitHub ignores it for the contributor graph.

## Providers

Configured in `<dataDir>/config.json`, seeded on first run with Kiro, Claude
Code, Gemini CLI, Codex, and — when running from a checkout — an offline mock
agent that always passes, so you can try the chat with no agent installed.

Adding another is a config entry, not code:
[PROVIDERS.md](PROVIDERS.md) has the recipe and an honest table of
which ones have actually been run.

The file is checked when it is read. An entry with a mistake in it — `args` as
a string, a missing `command`, an id used twice — is skipped with a warning on
the server's output, so the rest of your providers still load and the setup
page still works. Only a file with nothing usable left in it is an error, and
that error names each problem. Delete the file to get the defaults back.

| OS | Data directory |
|---|---|
| macOS | `~/Library/Application Support/kirochrome/` |
| Linux | `~/.local/share/kirochrome/` |

`KIROCHROME_DATA_DIR` overrides it. `KIROCHROME_PORT` changes the port.
`KIROCHROME_TRACE=1` logs every JSON-RPC frame to a JSONL file in the data
directory. `KIROCHROME_DEV=1` additionally trusts Vite's origin on port 5173 —
`npm run dev` sets it for you, and a normal run should not: 5173 is Vite's
default port, so trusting it means trusting any project you happen to have
running there.

If a provider fails, the setup page names the rung it failed on and what to do
about it. Two common ones:

- **`AGENT_NOT_FOUND`** — set an absolute path in `config.json`. Kiro installs
  to `~/.local/bin/kiro-cli`, which a GUI-launched process often cannot see.
- **Claude Code refuses to start** — its ACP adapter will not run nested inside
  an existing Claude Code session. Use a plain terminal.

## What did the agent actually send?

```bash
node scripts/diagnose.mjs
```

Lists every conversation with the ACP updates it received and whether the agent
reported context usage. Counts only — no conversation content is printed. Use it
when something is missing from the UI and you want to know whether the agent
sent it at all.

## Probing an agent directly

To see raw ACP traffic without the UI — useful when a provider misbehaves, or to
check what a new agent advertises:

```bash
cd spike && npm install
node handshake.mjs kiro          # or: claude-code, mock
```
