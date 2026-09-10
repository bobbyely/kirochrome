# The probe and the mock agent

Named for the phase 0 spike, but neither file is throwaway any more — see the
debt note in [../docs/PLAN.md](../docs/PLAN.md).

`handshake.mjs` is the ACP probe you run when onboarding a new agent
([../docs/PROVIDERS.md](../docs/PROVIDERS.md) has the recipe). `mock-agent.mjs`
is a seeded provider *and* the fixture `session.test.mjs` drives.

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
