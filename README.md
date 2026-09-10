# KiroChrome

A browser-based chat UI for CLI coding agents — the ergonomics of desktop apps
like Claude Code and Codex, in a browser, backed by [Kiro CLI](https://kiro.dev).

**Status:** working. Setup, streaming chat, tool calls, persistence, resume
and search all run; see [docs/PLAN.md](docs/PLAN.md) for what is next.

## How it works

Kiro CLI speaks the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) — JSON-RPC 2.0 over stdio, the "LSP for coding agents". So KiroChrome is
an ACP client with a web front end:

```
browser (React) ──WebSocket──▶ local server ──JSON-RPC/stdio──▶ kiro-cli acp
```

Because ACP is a standard, the same UI drives Gemini CLI natively, and Claude
Code or Codex through adapters. Adding a provider is a config entry, not a
parser.

## What it gives you

- streaming responses with real markdown and code rendering
- tool calls, file diffs and permission prompts as UI, not terminal scrollback
- structured questions from the agent answered as a form, not guessed at in prose
- a setup page that verifies each configured agent before you rely on it
- every session persisted, resumable and searchable
- refresh or crash mid-turn without losing anything
- hung commands killed cleanly, with no orphaned processes

## Docs

- [AGENTS.md](AGENTS.md) — the rules, for anyone (or anything) writing code here
- [AGENTS.local.md](AGENTS.local.md) — your own preferences, layered over those
  rules and blank by default. Put your style, habits and shortcuts in it; it
  takes precedence over AGENTS.md for everything except the invariants
- [docs/DESIGN.md](docs/DESIGN.md) — architecture and the reasoning behind it
- [docs/PLAN.md](docs/PLAN.md) — what is next, and recorded debt
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — what we implement of ACP, and how it behaves
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — adding an agent, and what has been run
- [docs/GOTCHAS.md](docs/GOTCHAS.md) — traps that already cost someone a day

## Development

Requires **Node 22.5+** (for the built-in `node:sqlite`). See `.nvmrc`.

```bash
git clone https://github.com/bobbyely/kirochrome.git
cd kirochrome
npm install
npm start                 # builds everything, serves http://127.0.0.1:4711
```

Open <http://127.0.0.1:4711>, press **Check** on a provider, and once it passes,
**New chat**.

### Development with hot reload

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

### Working on several features at once

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
[AGENTS.md](AGENTS.md) for the sequence.

Only run one dev server at a time — worktrees share ports 4711 and 5173, and a
single database.

### On a new machine

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

### Providers

Configured in `<dataDir>/config.json`, seeded on first run with Kiro, Claude
Code, Gemini CLI, Codex, and — when running from a checkout — an offline mock
agent that always passes, so you can try the chat with no agent installed.

Adding another is a config entry, not code:
[docs/PROVIDERS.md](docs/PROVIDERS.md) has the recipe and an honest table of
which ones have actually been run.

| OS | Data directory |
|---|---|
| macOS | `~/Library/Application Support/kirochrome/` |
| Linux | `~/.local/share/kirochrome/` |

`KIROCHROME_DATA_DIR` overrides it. `KIROCHROME_PORT` changes the port.
`KIROCHROME_TRACE=1` logs every JSON-RPC frame to a JSONL file in the data
directory.

If a provider fails, the setup page names the rung it failed on and what to do
about it. Two common ones:

- **`AGENT_NOT_FOUND`** — set an absolute path in `config.json`. Kiro installs
  to `~/.local/bin/kiro-cli`, which a GUI-launched process often cannot see.
- **Claude Code refuses to start** — its ACP adapter will not run nested inside
  an existing Claude Code session. Use a plain terminal.

### What did the agent actually send?

```bash
node scripts/diagnose.mjs
```

Lists every conversation with the ACP updates it received and whether the agent
reported context usage. Counts only — no conversation content is printed. Use it
when something is missing from the UI and you want to know whether the agent
sent it at all.

### Probing an agent directly

To see raw ACP traffic without the UI — useful when a provider misbehaves, or to
check what a new agent advertises:

```bash
cd spike && npm install
node handshake.mjs kiro          # or: claude-code, mock
```

## Prior art

[Kirodex](https://github.com/thabti/kirodex) solves the same problem as a Tauri
desktop app, also over ACP. See [docs/PRIOR-ART.md](docs/PRIOR-ART.md) for what
to borrow and what not to port.

Runs on macOS and Linux; Windows best-effort. Localhost only by design.
