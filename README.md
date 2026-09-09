# KiroChrome

A browser-based chat UI for CLI coding agents — the ergonomics of desktop apps
like Claude Code and Codex, in a browser, backed by [Kiro CLI](https://kiro.dev).

**Status:** design complete, implementation not started.

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
- a setup page that verifies each configured agent before you rely on it
- every session persisted, resumable and searchable
- refresh or crash mid-turn without losing anything
- hung commands killed cleanly, with no orphaned processes

## Docs

- [docs/DESIGN.md](docs/DESIGN.md) — architecture and the reasoning behind it
- [docs/PLAN.md](docs/PLAN.md) — phased implementation plan
- [AGENTS.md](AGENTS.md) — steering rules for agents working on this repo

## Development

Requires Node 22+ (see `.nvmrc`).

```bash
npm install
npm start                 # build everything, serve on http://127.0.0.1:4711
```

For a live-reloading UI, run the server and Vite separately:

```bash
npm run build && npm start -w @kirochrome/server   # :4711
npm run dev -w @kirochrome/web                     # :5173, proxies /api
```

Providers are configured in `<dataDir>/config.json`, seeded on first run:

| OS | Location |
|---|---|
| Linux | `~/.local/share/kirochrome/` |
| macOS | `~/Library/Application Support/kirochrome/` |

Set `KIROCHROME_DATA_DIR` to override, and `KIROCHROME_TRACE=1` to log every
JSON-RPC frame to a JSONL file in that directory.

**Current state:** the setup page works — it verifies each configured provider
rung by rung and reports exactly where a broken one fails. Chat is phase 2.

Runs on macOS and Linux; Windows best-effort. Localhost only by design.
