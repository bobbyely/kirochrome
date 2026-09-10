// Invariant 7: binding to loopback is not a boundary on its own, because any
// page in the user's browser can reach a local server. The Origin check is the
// boundary, and `PATCH /api/providers/:id` is what is behind it — it chooses
// which binary we spawn — so these tests are about who gets to ask.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { originAllowed } from "../dist/http.js";

const PORT = 4711;
const from = (origin) => originAllowed({ headers: origin === null ? {} : { origin } }, PORT);

afterEach(() => {
  delete process.env.KIROCHROME_DEV;
});

describe("the Origin allowlist", () => {
  it("allows our own origin, and a request that sends none", () => {
    assert.equal(from(`http://127.0.0.1:${PORT}`), true);
    assert.equal(from(`http://localhost:${PORT}`), true);
    // curl and same-origin fetches send no Origin at all.
    assert.equal(from(null), true);
  });

  it("rejects another site, and another port on this machine", () => {
    assert.equal(from("https://example.com"), false);
    assert.equal(from("http://127.0.0.1:9999"), false);
    // Close enough to look right, still not us.
    assert.equal(from(`https://127.0.0.1:${PORT}`), false);
    assert.equal(from(`http://127.0.0.1:${PORT}.example.com`), false);
  });

  it("trusts Vite's origin only when the dev runner asks for it", () => {
    // 5173 is Vite's default, so in a built install this origin is not "our
    // dev server", it is whatever else the user happens to be running.
    assert.equal(from("http://localhost:5173"), false);
    assert.equal(from("http://127.0.0.1:5173"), false);

    process.env.KIROCHROME_DEV = "1";
    assert.equal(from("http://localhost:5173"), true);
    assert.equal(from("http://127.0.0.1:5173"), true);
    // Still only that one port.
    assert.equal(from("http://localhost:5174"), false);
  });
});
