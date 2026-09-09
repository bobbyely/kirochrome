import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, KcError, KcEvent, ServerMessage, SessionSummary } from "@kirochrome/shared";

/**
 * Owns the WebSocket and mirrors the server's event log.
 *
 * The browser holds no authoritative state: it accumulates events by `seq` and
 * renders them. On reconnect it re-subscribes from its high-water mark, so a
 * dropped socket costs nothing — the turn kept running on the server.
 */
export function useChat() {
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<KcEvent[]>([]);
  const [error, setError] = useState<KcError | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [workspaces, setWorkspaces] = useState<string[] | null>(null);
  const [currentWorkspace, setCurrentWorkspace] = useState<string | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const lastSeq = useRef(0);
  const sessionId = useRef<string | null>(null);
  const retry = useRef<number | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  const connect = useCallback(() => {
    const socket = new WebSocket(`ws://${location.host}`);
    ws.current = socket;

    socket.onopen = () => {
      setConnected(true);
      // Catch up on anything missed while we were away.
      if (sessionId.current) {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            sessionId: sessionId.current,
            sinceSeq: lastSeq.current,
          } satisfies ClientMessage),
        );
      }
    };

    socket.onmessage = (raw) => {
      const msg = JSON.parse(String(raw.data)) as ServerMessage;
      switch (msg.type) {
        case "session_opened":
          sessionId.current = msg.session.id;
          lastSeq.current = 0;
          setSession(msg.session);
          setEvents([]);
          setError(null);
          send({ type: "subscribe", sessionId: msg.session.id, sinceSeq: 0 });
          break;
        case "events": {
          if (msg.events.length === 0) break;
          lastSeq.current = Math.max(lastSeq.current, ...msg.events.map((e) => e.seq));
          // De-duplicate by seq: a reconnect may overlap with what we hold.
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.seq));
            return [...prev, ...msg.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
          });
          break;
        }
        case "session_state":
          setSession(msg.session);
          break;
        case "sessions":
          setSessions(msg.sessions);
          break;
        case "workspaces":
          setWorkspaces(msg.workspaces);
          setCurrentWorkspace(msg.current);
          break;
        case "error":
          setError(msg.error);
          break;
      }
    };

    socket.onclose = () => {
      setConnected(false);
      retry.current = window.setTimeout(connect, 1_000);
    };
  }, [send]);

  useEffect(() => {
    connect();
    return () => {
      if (retry.current) window.clearTimeout(retry.current);
      const socket = ws.current;
      if (socket) {
        socket.onclose = null; // deliberate close: do not schedule a reconnect
        socket.close();
      }
    };
  }, [connect]);

  const openSession = useCallback(
    (providerId: string, cwd?: string) => send({ type: "open", providerId, ...(cwd ? { cwd } : {}) }),
    [send],
  );

  /** Attaches to a session that already exists, live or restored from disk. */
  const attachSession = useCallback(
    (id: string) => {
      sessionId.current = id;
      lastSeq.current = 0;
      setEvents([]);
      setError(null);
      send({ type: "subscribe", sessionId: id, sinceSeq: 0 });
    },
    [send],
  );

  const listSessions = useCallback(() => send({ type: "list_sessions" }), [send]);
  const listWorkspaces = useCallback(() => send({ type: "list_workspaces" }), [send]);

  const unqueue = useCallback(
    (index: number) => {
      if (sessionId.current) send({ type: "unqueue", sessionId: sessionId.current, index });
    },
    [send],
  );

  const renameSession = useCallback(
    (id: string, title: string) => send({ type: "rename_session", sessionId: id, title }),
    [send],
  );

  const answerPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      if (sessionId.current) send({ type: "permission_response", sessionId: sessionId.current, requestId, optionId });
    },
    [send],
  );

  const setAutoApprove = useCallback(
    (enabled: boolean) => {
      if (sessionId.current) send({ type: "set_auto_approve", sessionId: sessionId.current, enabled });
    },
    [send],
  );

  const setConfigOption = useCallback(
    (configId: string, value: string | boolean) => {
      if (sessionId.current) send({ type: "set_config_option", sessionId: sessionId.current, configId, value });
    },
    [send],
  );

  /** Re-attaches an agent to a stored conversation so it can be continued. */
  const resumeSession = useCallback(
    (id: string) => send({ type: "resume", sessionId: id, sinceSeq: lastSeq.current }),
    [send],
  );

  const prompt = useCallback(
    (text: string) => {
      if (!sessionId.current) return;
      send({ type: "prompt", sessionId: sessionId.current, text });
    },
    [send],
  );

  const cancel = useCallback(() => {
    if (sessionId.current) send({ type: "cancel", sessionId: sessionId.current });
  }, [send]);

  return {
    connected,
    session,
    sessions,
    workspaces,
    currentWorkspace,
    events,
    error,
    openSession,
    attachSession,
    resumeSession,
    listSessions,
    listWorkspaces,
    renameSession,
    unqueue,
    setConfigOption,
    answerPermission,
    setAutoApprove,
    prompt,
    cancel,
  };
}
