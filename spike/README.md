# Phase 0 spike

Throwaway ACP handshake probe. Its findings feed the phase 1 check ladder.

```bash
cd spike && npm install
node handshake.mjs mock          # offline fixture, no auth
node handshake.mjs claude-code   # real agent — see caveat below
node handshake.mjs kiro          # on the work machine
```

`mock-agent.mjs` is a minimal ACP agent kept as a test fixture: deterministic,
offline, and able to fake failures on demand.

**Caveat:** `claude-agent-acp` refuses to start inside an existing Claude Code
session — it shares runtime resources and can crash both. Run it from a plain
terminal.
