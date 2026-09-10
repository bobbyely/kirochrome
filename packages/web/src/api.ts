import type {
  AgentSessionsResponse,
  CheckResponse,
  KcError,
  ProvidersResponse,
} from "@kirochrome/shared";

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

export const updateProvider = (id: string, patch: { command?: string; args?: string[] }) =>
  request<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

/**
 * Conversations the agent itself is holding.
 *
 * Spawns a probe agent on the server, so it is asked for on demand rather than
 * on every visit to the new-chat page.
 */
export const fetchAgentSessions = (id: string) =>
  request<AgentSessionsResponse>(`/api/providers/${encodeURIComponent(id)}/sessions`);

export const runCheck = (id: string) =>
  request<CheckResponse>(`/api/providers/${encodeURIComponent(id)}/check`, { method: "POST" });
