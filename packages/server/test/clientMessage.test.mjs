// Runs against the compiled output, so it exercises what actually ships.
//
// The WebSocket frame is one of the two inputs that are not ours. These tests
// hold the door shut: a malformed frame must come back as a typed KcError to
// that one client, and must never throw out of the socket's message listener.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIENT_MESSAGE_TYPES, parseClientMessage, validateClientMessage } from "@kirochrome/shared";
import { handleFrame } from "../dist/ws.js";

/** Drives one frame through the real handler and returns what was sent back. */
async function frame(raw, sessions = {}) {
  const sent = [];
  const watch = () => {};
  await handleFrame(raw, sessions, (msg) => sent.push(msg), watch, { includeArchived: false });
  return sent;
}

const rejection = (sent) => {
  assert.equal(sent.length, 1, `expected exactly one reply, got ${JSON.stringify(sent)}`);
  assert.equal(sent[0].type, "error");
  return sent[0].error;
};

describe("inbound frame validation", () => {
  it("rejects a frame that is not JSON at all", async () => {
    const error = rejection(await frame("not json {"));
    assert.equal(error.code, "MESSAGE_INVALID");
    assert.match(error.message, /valid JSON/);
    assert.ok(error.remediation, "every failure carries a remediation");
    assert.ok(error.cause, "the parse failure is preserved, never discarded");
  });

  it("rejects JSON that is not an object", async () => {
    for (const raw of ["42", '"prompt"', "null", "[{}]"]) {
      const error = rejection(await frame(raw));
      assert.equal(error.code, "MESSAGE_INVALID");
      assert.match(error.message, /must be a JSON object/);
    }
  });

  it("rejects a missing or unknown type", async () => {
    assert.match(rejection(await frame('{"sessionId":"s1"}')).message, /must have a 'type'/);
    assert.match(rejection(await frame('{"type":"drop_database"}')).message, /unknown message type/);
    // A non-string type must not be looked up as one.
    assert.match(rejection(await frame('{"type":{"toString":1}}')).message, /unknown message type/);
  });

  it("rejects a known type whose field is missing", async () => {
    const error = rejection(await frame('{"type":"prompt","sessionId":"s1"}'));
    assert.equal(error.code, "MESSAGE_INVALID");
    assert.match(error.message, /'prompt' is missing 'text'/);
  });

  it("rejects a known type whose field is the wrong type", async () => {
    // Each of these used to reach a handler and fail there, or worse, not fail.
    const cases = [
      ['{"type":"prompt","sessionId":"s1","text":42}', /'text' must be a string/],
      ['{"type":"prompt","sessionId":null,"text":"hi"}', /'sessionId' must be a string/],
      ['{"type":"unqueue","sessionId":"s1","index":"2"}', /'index' must be a finite number/],
      ['{"type":"move_queued","sessionId":"s1","from":1e999,"to":0}', /'from' must be a finite number/],
      ['{"type":"set_auto_approve","sessionId":"s1","enabled":"yes"}', /'enabled' must be a boolean/],
      ['{"type":"archive_session","sessionId":"s1","archived":1}', /'archived' must be a boolean/],
      ['{"type":"search","query":["x"]}', /'query' must be a string/],
      ['{"type":"adopt","providerId":"mock","cwd":"/tmp"}', /'adopt' is missing 'agentSessionId'/],
      ['{"type":"subscribe","sessionId":"s1","sinceSeq":"0"}', /'sinceSeq' must be a finite number/],
      [
        '{"type":"elicitation_response","sessionId":"s1","requestId":"r","action":"maybe"}',
        /'action' must be 'accept', 'decline' or 'cancel'/,
      ],
      [
        '{"type":"set_config_option","sessionId":"s1","configId":"model","value":{"a":1}}',
        /'value' must be a string or a boolean/,
      ],
    ];
    for (const [raw, expected] of cases) {
      const error = rejection(await frame(raw));
      assert.equal(error.code, "MESSAGE_INVALID");
      assert.match(error.message, expected);
    }
  });

  it("rejects a wrong-typed optional field but accepts its absence", async () => {
    assert.match(
      rejection(await frame('{"type":"prompt","sessionId":"s1","text":"hi","images":["nope"]}')).message,
      /'images' must be an array/,
    );
    assert.match(
      rejection(await frame('{"type":"list_sessions","includeArchived":"true"}')).message,
      /'includeArchived' must be a boolean/,
    );
    // Absent optional fields are fine — this one reaches the handler.
    const sent = await frame('{"type":"list_sessions"}', { list: () => [] });
    assert.deepEqual(sent, [{ type: "sessions", sessions: [] }]);
  });

  it("never rejects a frame the browser actually sends", async () => {
    const valid = [
      { type: "open", providerId: "mock" },
      { type: "open", providerId: "mock", cwd: "/tmp" },
      { type: "adopt", providerId: "mock", agentSessionId: "cli-1", cwd: "/tmp" },
      { type: "adopt", providerId: "mock", agentSessionId: "cli-1", cwd: "/tmp", title: "First" },
      { type: "subscribe", sessionId: "s1", sinceSeq: 0 },
      { type: "prompt", sessionId: "s1", text: "hi" },
      { type: "prompt", sessionId: "s1", text: "hi", images: [{ mime: "image/png", data: "aa" }] },
      { type: "cancel", sessionId: "s1" },
      { type: "resume", sessionId: "s1", sinceSeq: 12 },
      { type: "list_workspaces" },
      { type: "set_config_option", sessionId: "s1", configId: "model", value: "sonnet" },
      { type: "set_config_option", sessionId: "s1", configId: "thinking", value: true },
      { type: "permission_response", sessionId: "s1", requestId: "r", optionId: "allow" },
      { type: "permission_response", sessionId: "s1", requestId: "r", optionId: null },
      { type: "elicitation_response", sessionId: "s1", requestId: "r", action: "decline" },
      {
        type: "elicitation_response",
        sessionId: "s1",
        requestId: "r",
        action: "accept",
        content: { name: "a", n: 1, ok: true, tags: ["x"] },
      },
      { type: "set_auto_approve", sessionId: "s1", enabled: true },
      { type: "rename_session", sessionId: "s1", title: "T" },
      { type: "unqueue", sessionId: "s1", index: 0 },
      { type: "edit_queued", sessionId: "s1", index: 0, text: "t" },
      { type: "move_queued", sessionId: "s1", from: 0, to: 1 },
      { type: "archive_session", sessionId: "s1", archived: true },
      { type: "search", query: "q" },
      { type: "command_options", sessionId: "s1", command: "/c", partial: "" },
      { type: "list_sessions", includeArchived: true },
    ];
    for (const msg of valid) {
      const checked = validateClientMessage(msg);
      assert.ok(checked.ok, `${msg.type} was rejected: ${checked.problem}`);
    }
    // Every member of the union is covered, so a message type added without an
    // example here fails rather than going untested.
    assert.deepEqual(
      [...new Set(valid.map((m) => m.type))].sort(),
      [...CLIENT_MESSAGE_TYPES].sort(),
      "one valid example per ClientMessage type",
    );
  });

  it("ignores unknown extra properties rather than rejecting them", () => {
    // An older server must still serve a newer page's frames.
    const checked = validateClientMessage({ type: "search", query: "q", futureField: 1 });
    assert.ok(checked.ok);
  });

  it("reports a problem for anything it rejects", () => {
    const bad = parseClientMessage("{");
    assert.equal(bad.ok, false);
    assert.ok(bad.problem.length > 0);
  });
});

describe("dispatch errors reach the client typed", () => {
  it("passes a KcError from a handler straight through, with the session id", async () => {
    const sessions = {
      requireLive() {
        throw { code: "SESSION_NOT_LIVE", message: "not live" };
      },
    };
    const sent = await frame('{"type":"cancel","sessionId":"s9"}', sessions);
    assert.equal(sent[0].type, "error");
    assert.equal(sent[0].error.code, "SESSION_NOT_LIVE");
    assert.equal(sent[0].sessionId, "s9");
  });

  it("turns an untyped throw into INTERNAL rather than an unhandled rejection", async () => {
    const sessions = {
      search() {
        throw new Error("boom");
      },
    };
    const sent = await frame('{"type":"search","query":"q"}', sessions);
    assert.equal(sent[0].error.code, "INTERNAL");
    assert.match(sent[0].error.cause, /boom/);
  });
});
