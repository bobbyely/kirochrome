import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderCheckResult } from "@kirochrome/shared";
import { cardStatus, isReady } from "../providerStatus.ts";

const passed = { status: "ok" } as ProviderCheckResult;
const refused = { code: "ORIGIN_REJECTED", message: "no" } as const;

describe("cardStatus", () => {
  it("does not say Ready when the re-check request itself failed", () => {
    // The stored result passed, but the attempt to confirm it never ran.
    assert.equal(cardStatus(false, refused, passed), "unverified");
  });

  it("reports the stored result when nothing is in the way", () => {
    assert.equal(cardStatus(false, null, passed), "ok");
    assert.equal(cardStatus(false, null, { status: "stale" } as ProviderCheckResult), "stale");
    assert.equal(cardStatus(false, null, null), "unchecked");
  });

  it("shows running above everything else", () => {
    assert.equal(cardStatus(true, refused, passed), "running");
  });
});

describe("isReady", () => {
  it("excludes a provider whose last check stands unverified", () => {
    assert.equal(isReady(null, passed), true);
    assert.equal(isReady(refused, passed), false);
    assert.equal(isReady(null, null), false);
  });
});
