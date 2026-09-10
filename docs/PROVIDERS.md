# Providers

A provider is **which binary to spawn**. That is all. Models, modes,
capabilities and commands all come from the protocol at runtime and are never
written down here — see invariant 5 in [AGENTS.md](../AGENTS.md).

So adding an agent is a config entry, not code. This file is how.

## Configured

Providers live in `<dataDir>/config.json`, seeded on first run. Edit that file
to add, remove or correct one; the setup page re-reads it.

| OS | Data directory |
|---|---|
| macOS | `~/Library/Application Support/kirochrome/` |
| Linux | `~/.local/share/kirochrome/` |

```jsonc
{
  "id": "gemini",
  "name": "Gemini CLI",
  "command": "gemini",
  "args": ["--acp"],
  "install": {                      // optional: shown when the binary is missing
    "darwin": "npm install -g @google/gemini-cli",
    "linux":  "npm install -g @google/gemini-cli"
  },
  "docsUrl": "https://github.com/google-gemini/gemini-cli"
}
```

`cwd`, `env` and `authMethodId` are the other optional fields. **`env` is never
logged**, and `config.json` is `chmod 0600` because it can hold secrets.

## What has actually been run

Honesty matters more than a long table here: a provider listed as working that
nobody has run is worse than no entry, because it sends someone debugging their
own machine.

| Provider | Command | Verified? |
|---|---|---|
| Mock agent | `node spike/mock-agent.mjs` | **Yes** — all seven rungs, every release. It is the test fixture. |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` | **Yes** — full ladder, ACP v1, `loadSession`, an `authMethods` entry, streaming and tool calls. |
| Kiro CLI | `kiro-cli acp` | **No** — Kiro is only on the work machine. Its dialect is the one open protocol question. |
| Gemini CLI | `gemini --acp` | **Partly** — the flag is confirmed to exist (`--experimental-acp` is deprecated in favour of it). No handshake has been run. |
| Codex | `npx -y @zed-industries/codex-acp` | **No** — the adapter package exists and is current; nothing beyond that has been checked. |

Correct a row the moment you run one. A "no" that has quietly become a "yes"
is the same problem as a wrong "yes".

### Known caveat

**The Claude Code adapter refuses to start inside an existing Claude Code
session** — it shares runtime resources and can crash both. Run it from a plain
terminal. The failure surfaces as `-32603 "Query closed before response
received"` at `session/new`, which is useless on its own; the real cause is in
the agent's stderr, which the setup page shows behind a details toggle.

## Adding an agent

1. **Probe it first, without the UI.** The probe prints the handshake and the
   raw update stream, which is what you need to see before deciding anything:

   ```bash
   cd spike && npm install
   node handshake.mjs kiro                    # mock, claude-code, gemini, codex
   node handshake.mjs -- some-agent --acp     # anything not in that list
   ```

   The `--` form matters here: a brand-new agent can be probed before it is
   written down anywhere.

   **Expect it to end at `terminal/create`.** The probe is a bare client with no
   terminal handlers, so an agent that runs a command will fail there. That is
   the probe's limit, not the agent's — the server implements those methods.

2. **Read what it advertises.** `protocolVersion` must be 1. Note whether it
   returns `configOptions`, the legacy `availableModels`/`modes`, or both —
   both is normal, see [PROTOCOL.md](PROTOCOL.md). Note `loadSession`: without
   it, conversations will not resume.

3. **Add the config entry**, with an `install` hint if there is a sensible one.

4. **Run the check ladder** from the setup page. It reports the rung it fell
   off, with a remediation — that is the point of it, so read the rung rather
   than guessing.

5. **Update the table above**, including a "no" that is now a "yes".

If it fails at `initialize` after a long wait, the command probably is not an
ACP server at all. If it fails with `-32000`, it wants `authenticate` — pick an
auth method on the setup page.

## When an agent needs special handling

It usually does not, and reaching for a special case is normally a sign the
data-driven path was not read carefully. But agents do ship extensions —
`_kiro.dev/commands/options` is one.

The rules for those:

- Probe the extension **once** per session; a failure marks it unsupported
  rather than being retried.
- The standard path must still work when the probe fails. An extension is an
  enhancement, never a requirement.
- Never branch on the provider `id`. Branch on what the agent advertised.

## Not found?

`AGENT_NOT_FOUND` shows the paths tried, the `install` hint from the provider's
config, and a field to set an absolute path.

An absolute path is often the actual fix rather than installing anything:
GUI-launched processes frequently do not inherit a shell `PATH`, so a binary
that works in your terminal is invisible to the server. Kiro installs to
`~/.local/bin/kiro-cli`, which is the common case.
