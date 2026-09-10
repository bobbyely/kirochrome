// Runs against the compiled output, so it exercises what actually ships.
//
// config.json is hand-edited, which makes it the second input that is not ours.
// The rule these tests pin down: one broken entry is dropped and reported, so
// the setup page that is the only way to fix the file still loads; a file with
// nothing usable in it is a typed error that names each problem.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let loadConfig, updateProvider, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "kc-config-"));
  process.env.KIROCHROME_DATA_DIR = dir;
  ({ loadConfig, updateProvider } = await import("../dist/config.js"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (contents) =>
  writeFileSync(join(dir, "config.json"), typeof contents === "string" ? contents : JSON.stringify(contents));

const ok = { id: "good", name: "Good", command: "/bin/true", args: [] };

/** Runs loadConfig with console.warn silenced, and returns the result. */
function load() {
  const original = console.warn;
  console.warn = () => {};
  try {
    return loadConfig();
  } finally {
    console.warn = original;
  }
}

/** Asserts the call fails with a typed KcError, and returns it. */
const failure = (fn) => {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, "expected a throw");
  assert.equal(thrown.code, "CONFIG_INVALID", `expected a typed CONFIG_INVALID, got ${JSON.stringify(thrown)}`);
  assert.ok(thrown.remediation, "every failure carries a remediation");
  return thrown;
};

describe("a config file that cannot be used at all", () => {
  it("rejects a file that is not JSON, naming the file and keeping the cause", () => {
    write("{ providers: [] ,,");
    const err = failure(load);
    assert.match(err.message, /is not valid JSON/);
    assert.match(err.message, /config\.json/);
    assert.ok(err.cause, "the parse error is preserved");
  });

  it("rejects JSON that is not an object", () => {
    for (const contents of ["[]", "42", '"providers"', "null"]) {
      write(contents);
      assert.match(failure(load).message, /must contain a JSON object/);
    }
  });

  it("rejects a file with no providers array", () => {
    write({ providers: { kiro: {} } });
    assert.match(failure(load).message, /no 'providers' array/);
    write({ theme: "dark" });
    assert.match(failure(load).message, /no 'providers' array/);
  });

  it("rejects a file whose every provider is broken, listing what is wrong", () => {
    write({ providers: [{ name: "No id" }, "kiro", { id: "x", name: "X" }] });
    const err = failure(load);
    assert.match(err.message, /defines no usable provider/);
    assert.equal(err.detail.problems.length, 3);
    assert.match(err.detail.problems[0], /providers\[0\].*'id' must be a non-empty string/);
    assert.match(err.detail.problems[1], /providers\[1\].*must be an object/);
    assert.match(err.detail.problems[2], /providers\[2\].*'command' must be a non-empty string/);
  });
});

describe("a partially valid config file", () => {
  it("keeps the good providers, drops the bad ones, and reports each", () => {
    write({
      providers: [
        ok,
        { id: "bad-args", name: "Bad", command: "x", args: "acp" },
        { id: "", name: "Blank", command: "x" },
        { id: "bad-env", name: "Bad env", command: "x", env: { KEY: 1 } },
        { id: "second", name: "Second", command: "/bin/false", args: ["acp"] },
      ],
    });
    const config = load();
    assert.deepEqual(config.providers.map((p) => p.id), ["good", "second"]);
    assert.equal(config.problems.length, 3);
    assert.match(config.problems[0], /providers\[1\].*'args' must be an array of strings/);
    assert.match(config.problems[1], /providers\[2\].*'id' must be a non-empty string/);
    assert.match(config.problems[2], /providers\[3\].*'env' must be an object of strings/);
  });

  it("drops a duplicate id, which would otherwise be unreachable dead weight", () => {
    write({ providers: [ok, { ...ok, name: "Shadowed", command: "/bin/false" }] });
    const config = load();
    assert.equal(config.providers.length, 1);
    assert.equal(config.providers[0].name, "Good");
    assert.match(config.problems[0], /duplicate id 'good'/);
  });

  it("defaults omitted args, since that is what a hand-written entry means", () => {
    write({ providers: [{ id: "bare", name: "Bare", command: "/bin/true" }] });
    assert.deepEqual(load().providers[0].args, []);
  });

  it("accepts a legitimately empty registry", () => {
    write({ providers: [] });
    const config = load();
    assert.deepEqual(config.providers, []);
    assert.deepEqual(config.problems, []);
  });

  it("keeps the optional fields it validates", () => {
    write({
      providers: [
        { ...ok, cwd: "/tmp", env: { TOKEN: "t" }, install: { linux: "npm i -g x" }, docsUrl: "https://x" },
      ],
    });
    const provider = load().providers[0];
    assert.equal(provider.cwd, "/tmp");
    assert.deepEqual(provider.env, { TOKEN: "t" });
    assert.deepEqual(provider.install, { linux: "npm i -g x" });
  });
});

describe("seeding and writing", () => {
  it("seeds defaults when there is no file yet", () => {
    rmSync(join(dir, "config.json"), { force: true });
    const config = load();
    assert.ok(config.providers.length > 0);
    assert.deepEqual(config.problems, []);
    // Written back, and readable again without complaint.
    assert.deepEqual(load().providers, config.providers);
  });

  it("does not write 'problems' into the file it just read", () => {
    write({ providers: [ok, { id: "bad", name: "Bad", command: "x", args: 1 }] });
    const original = console.warn;
    console.warn = () => {};
    try {
      updateProvider("good", { command: "/bin/echo" });
    } finally {
      console.warn = original;
    }

    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(Object.keys(onDisk), ["providers"]);
    assert.equal(onDisk.providers[0].command, "/bin/echo");
    // A rewrite persists what loaded, so the dropped entry is now gone from
    // disk. Deliberate, and the reason the drop is warned about.
    assert.equal(onDisk.providers.length, 1);
  });
});
