// `session/list` against the real mock agent over ACP: the capability gate,
// the cursor loop, and the timeout that stops a hung agent becoming a spinner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, "..", "..", "..", "spike", "mock-agent.mjs");

/** The mock's behaviour is switched by its environment, so each case is a provider. */
const providerWith = (env) => ({
  id: "mock",
  name: "Mock",
  command: process.execPath,
  args: [MOCK],
  ...(env ? { env } : {}),
});

let listAgentSessions, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-agent-sessions-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  ({ listAgentSessions } = await import("../dist/agentSessions.js"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("session/list", () => {
  it("pages through the agent's own conversations, skipping invalid entries", async () => {
    const listed = await listAgentSessions(providerWith());

    assert.equal(listed.supported, true);
    assert.equal(listed.truncated, false);
    assert.deepEqual(
      listed.sessions.map((s) => s.sessionId),
      ["cli-1", "cli-2", "cli-3"],
      "the cursor must be followed to the second page, and the entry with no sessionId skipped",
    );

    const [first, second] = listed.sessions;
    assert.equal(first.cwd, "/tmp/one");
    assert.equal(first.title, "First");
    assert.equal(first.updatedAt, "2026-01-01T00:00:00Z");
    // ACP makes title and updatedAt optional; they must narrow to null, not undefined.
    assert.equal(second.title, null);
    assert.equal(second.updatedAt, null);
  });

  it("reports the capability as absent rather than failing", async () => {
    // An agent that keeps no history of its own omits `sessionCapabilities.list`.
    const listed = await listAgentSessions(providerWith({ MOCK_NO_SESSION_LIST: "1" }));
    assert.equal(listed.supported, false);
    assert.deepEqual(listed.sessions, []);
  });

  it("turns a hung agent into a typed error, not a spinner", async () => {
    await assert.rejects(
      () => listAgentSessions(providerWith({ MOCK_HANG_SESSION_LIST: "1" }), { listTimeoutMs: 200 }),
      (err) => {
        assert.equal(err.code, "RPC_TIMEOUT", "invariant 10: every RPC has a timeout");
        assert.ok(err.remediation, "and a remediation");
        return true;
      },
    );
  });
});
