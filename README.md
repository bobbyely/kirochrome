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
- every session persisted, resumable and searchable
- refresh or crash mid-turn without losing anything
- hung commands killed cleanly, with no orphaned processes

## Docs

- [docs/DESIGN.md](docs/DESIGN.md) — architecture and the reasoning behind it
- [docs/PLAN.md](docs/PLAN.md) — phased implementation plan
- [AGENTS.md](AGENTS.md) — steering rules for agents working on this repo

## Development

Nothing to run yet — see [docs/PLAN.md](docs/PLAN.md) phase 0.

Runs on macOS and Linux; Windows best-effort. Localhost only by design.
