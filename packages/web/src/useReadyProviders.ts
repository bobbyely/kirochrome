import { useEffect, useState } from "react";
import type { ProviderView } from "@kirochrome/shared";
import { fetchProviders } from "./api.js";

/**
 * The providers a conversation may be started on or moved to: those whose
 * setup check passed (invariant 11). Fetched once per mount; a provider
 * checked while this is open shows up on the next.
 */
export function useReadyProviders(): ProviderView[] {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  useEffect(() => {
    let stale = false;
    fetchProviders()
      .then((res) => !stale && setProviders(res.providers.filter((p) => p.lastCheck?.status === "ok")))
      .catch(() => {
        // The composer works without the list; the picker simply does not appear.
      });
    return () => {
      stale = true;
    };
  }, []);
  return providers;
}
