import { useEffect, useState } from "react";
import type { ProviderView } from "@kirochrome/shared";
import { ApiError, fetchProviders } from "./api.js";

/**
 * The providers a conversation may be started on or moved to: those whose
 * setup check passed (invariant 11). `null` until the list has arrived, so a
 * page can show "Loading…" rather than an empty choice; `error` is the
 * server's message when it did not. Fetched once per mount — a provider
 * checked while the page is open shows up on the next visit.
 */
export function useReadyProviders(): { providers: ProviderView[] | null; error: string | null } {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    fetchProviders()
      .then((res) => !stale && setProviders(res.providers.filter((p) => p.lastCheck?.status === "ok")))
      .catch((err: unknown) => !stale && setError(err instanceof ApiError ? err.kc.message : String(err)));
    return () => {
      stale = true;
    };
  }, []);
  return { providers, error };
}
