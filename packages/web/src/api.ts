import type { CheckResponse, KcError, ProvidersResponse } from "@kirochrome/shared";

/** Thrown for any non-2xx response, carrying the server's typed error. */
export class ApiError extends Error {
  constructor(readonly kc: KcError) {
    super(kc.message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const error = (body as { error?: KcError } | null)?.error;
    throw new ApiError(error ?? { code: "INTERNAL", message: `Request failed (${res.status}).` });
  }
  return body as T;
}

export const fetchProviders = () => request<ProvidersResponse>("/api/providers");

export const runCheck = (id: string) =>
  request<CheckResponse>(`/api/providers/${encodeURIComponent(id)}/check`, { method: "POST" });
