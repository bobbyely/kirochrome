import type { KcError, ProviderCheckResult } from "@kirochrome/shared";

export type CardStatus = "running" | "unverified" | "ok" | "failed" | "stale" | "unchecked";

/**
 * What the setup card says about a provider.
 *
 * A re-check whose *request* failed — the server refused it or was unreachable —
 * leaves the provider **unverified**, whatever the stored result says. The
 * stored result is still shown, as the last check that did run, but the pill
 * must not read "Ready" beside an error saying we could not confirm that.
 */
export function cardStatus(
  running: boolean,
  checkError: KcError | null,
  lastCheck: ProviderCheckResult | null,
): CardStatus {
  if (running) return "running";
  if (checkError) return "unverified";
  return lastCheck?.status ?? "unchecked";
}

/** A provider counts as ready only if its last check passed *and* still stands. */
export function isReady(checkError: KcError | null, lastCheck: ProviderCheckResult | null): boolean {
  return lastCheck?.status === "ok" && checkError === null;
}
