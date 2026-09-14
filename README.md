# KiroChrome

**A browser chat UI for CLI coding agents.** The feel of the Claude Code and
Codex desktop apps, in a tab, for any agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) — Kiro CLI, Claude
Code, Gemini CLI, Codex.

Your agent runs on your machine, in your project, as it always has. KiroChrome
gives it a proper window: streamed answers with real markdown, tool calls and
diffs as things you can read, permissions and questions as things you can
click, and every conversation kept, searchable and resumable.

```bash
git clone https://github.com/bobbyely/kirochrome.git && cd kirochrome
npm install && npm start        # http://127.0.0.1:4711
```

Needs Node 22.5+. Press **Check** on an agent, then **New chat**. No agent
installed yet? A built-in mock agent lets you try the chat anyway.

## What you get

**A real transcript.** Streaming markdown and highlighted code. Tool calls
fold into one line while the agent works and open on demand. File edits show
as diffs. Permission prompts and the agent's structured questions are forms,
not prose to parse.

**Changes at a glance.** A pane beside the conversation lists every file the
agent has edited, with its net diff — no hunting the transcript for the tool
call that did it.

**Nothing lost.** Every conversation is persisted as it happens. Refresh,
close the tab, restart the server: reopen it and pick up where it was. Search
across all of them. Conversations you started in the agent's own terminal can
be continued here too.

**Stay in control mid-turn.** Type while the agent works and the message
queues for when it finishes — or **Interrupt & send** to cut the turn short
for something that cannot wait. Stop kills a runaway turn cleanly, with no
orphaned processes left behind.

**Schedules.** Save a prompt and have the server run it every N minutes or
daily at a time — a nightly review, a CI check, a morning brief. Each run is an
ordinary conversation you can open and continue. The browser can be closed;
the server cannot.

**Rooms.** Two or more agents and you, talking in turns — a planner and a
critic working over a topic, say. Each agent is its own conversation; the room
decides who speaks next and shows each one what was said since its last turn.
Each participant gets its own model and opening command. Typing holds the
room, Enter sends, Cmd+Enter cuts in on whoever is speaking, **Steer** changes
the topic or the rules mid-conversation, and a turn budget and credit cap keep
it from running away.

**Context you can see.** A meter shows how much of the agent's window is used,
and what the conversation has cost where the agent reports it.

**Any ACP agent.** Adding one is a config entry, not code. A setup page checks
**Any ACP agent.** Adding one is a config entry, not code. A setup page checks
each agent before you rely on it and names exactly what is wrong when it
fails — and remembers what it offers, so you pick the model before a chat,
schedule or room starts, and can open with a command like `/effort high`.
Settings an agent exposes only as a command, like Kiro's `/effort`, sit beside
the model picker anyway.

**Something to do while you wait.** Two word games in the corner. A game in
progress survives switching conversations.

## How it works

```
browser (React) ──WebSocket──▶ local server ──JSON-RPC/stdio──▶ your agent
```

The server is the ACP client. It owns the agent process and the turn, so a
dropped socket costs nothing; the browser only renders an append-only event
log. Localhost only, by design. macOS and Linux; Windows best-effort — it
runs, but agents a crashed server leaves behind are not cleaned up there.

## Docs

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — running from a checkout, hot
  reload, worktrees, provider config, environment variables, diagnostics
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — adding an agent, and what has been run
- [docs/DESIGN.md](docs/DESIGN.md) — the architecture and the reasoning behind it
- [docs/PLAN.md](docs/PLAN.md) — what is next
- [AGENTS.md](AGENTS.md) — the rules, for anyone (or anything) writing code here
- [docs/PROTOCOL.md](docs/PROTOCOL.md) · [docs/GOTCHAS.md](docs/GOTCHAS.md)
