import type {
  AgentSessionsResponse,
  CheckResponse,
  KcError,
  ProvidersResponse,
  Room,
  RoomInput,
  RoomView,
  Schedule,
  ScheduleInput,
  ScheduleRun,
  SchedulesResponse,
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

/** All schedules with their recent runs; one id for a schedule's full history. */
export const fetchSchedules = (id?: string) =>
  request<SchedulesResponse>(id ? `/api/schedules?id=${encodeURIComponent(id)}&runs=200` : "/api/schedules");

export const createSchedule = (input: ScheduleInput) =>
  request<{ schedule: Schedule }>("/api/schedules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

export const updateSchedule = (id: string, patch: Partial<ScheduleInput> & { status?: Schedule["status"] }) =>
  request<{ schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

export const deleteSchedule = (id: string) =>
  request<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Resolves when the run has finished, however it ended. */
export const runSchedule = (id: string) =>
  request<{ run: ScheduleRun }>(`/api/schedules/${encodeURIComponent(id)}/run`, { method: "POST" });

export const fetchRooms = () => request<{ rooms: RoomView[] }>("/api/rooms");
export const fetchRoom = (id: string) => request<{ room: RoomView }>(`/api/rooms/${encodeURIComponent(id)}`);

export const createRoom = (input: RoomInput) =>
  request<{ room: Room }>("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

export const deleteRoom = (id: string) =>
  request<{ ok: true }>(`/api/rooms/${encodeURIComponent(id)}`, { method: "DELETE" });

/** The four verbs: say (optionally cutting in), hold while typing, resume a round, stop. */
export const roomVerb = (
  id: string,
  verb: "say" | "hold" | "resume" | "stop" | "reconnect" | "steer",
  body: unknown = {},
) =>
  request<{ room: RoomView }>(`/api/rooms/${encodeURIComponent(id)}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
