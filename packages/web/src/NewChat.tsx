import { useEffect, useMemo, useState } from "react";
import type { AgentSessionInfo, AgentSessionsResponse, KcError, ProviderView } from "@kirochrome/shared";
import { advertisesLoadSession, advertisesSessionList } from "@kirochrome/shared";
import { ApiError, fetchAgentSessions, fetchProviders } from "./api.js";
import { useChat } from "./useChat.js";

/** What the parent needs to open a conversation the agent owns. */
export interface AdoptTarget {
  agentSessionId: string;
  cwd: string;
  title: string | null;
}

/**
 * Pick a verified provider and a working directory.
 *
 * Only providers whose setup check passed are offered — the chat flow trusts
 * the check rather than re-diagnosing. The directory matters more than it
 * looks: ACP sessions are workspace-scoped, so the agent reads that folder's
 * project context and git state.
 */
export function NewChat({
  onStart,
  onAdopt,
  onOpenSession,
  onNeedsSetup,
}: {
  onStart: (providerId: string, cwd: string) => void;
  onAdopt: (providerId: string, target: AdoptTarget) => void;
  onOpenSession: (sessionId: string) => void;
  onNeedsSetup: () => void;
}) {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const { connected, workspaces, currentWorkspace, listWorkspaces } = useChat();

  useEffect(() => {
    fetchProviders()
      .then((r) => setProviders(r.providers))
      .catch((err) => setError(err instanceof ApiError ? err.kc.message : String(err)));
  }, []);

  useEffect(() => {
    if (connected) listWorkspaces();
  }, [connected, listWorkspaces]);

  useEffect(() => {
    if (!cwd && currentWorkspace) setCwd(currentWorkspace);
  }, [cwd, currentWorkspace]);

  const ready = useMemo(() => providers?.filter((p) => p.lastCheck?.status === "ok") ?? [], [providers]);
  // Offered only where the agent said it can list its own sessions — the check
  // already recorded what it advertised, so nothing is assumed or hardcoded.
  const listers = useMemo(
    () => ready.filter((p) => advertisesSessionList(p.lastCheck?.capabilities)),
    [ready],
  );

  if (error) return <div className="page"><div className="banner">{error}</div></div>;
  if (!providers) return <div className="page"><p className="muted">Loading…</p></div>;

  if (ready.length === 0) {
    return (
      <div className="page">
        <h1>New chat</h1>
        <p className="muted">
          No provider has passed its setup check yet, so there is nothing to chat with.
        </p>
        <button className="primary" onClick={onNeedsSetup}>
          Go to Setup
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>New chat</h1>

      <label className="field">
        <span className="field-label">Working directory</span>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/project"
          spellCheck={false}
        />
        <span className="field-hint">
          The agent reads this folder&rsquo;s files, git state and project instructions.
        </span>
      </label>

      {workspaces && workspaces.length > 0 && (
        <div className="chips">
          {workspaces.map((w) => (
            <button key={w} className={`chip ${w === cwd ? "chip-on" : ""}`} onClick={() => setCwd(w)}>
              {w}
            </button>
          ))}
        </div>
      )}

      <h2 className="section-label">Provider</h2>
      <div className="provider-grid">
        {ready.map((provider) => (
          <button
            key={provider.id}
            className="provider-choice"
            disabled={!cwd.trim()}
            onClick={() => onStart(provider.id, cwd.trim())}
          >
            <strong>{provider.name}</strong>
            <span className="muted">
              {provider.lastCheck?.agentInfo?.title ?? provider.lastCheck?.agentInfo?.name ?? provider.command}
            </span>
          </button>
        ))}
      </div>

      {listers.length > 0 && (
        <>
          <h2 className="section-label">Conversations your agent already has</h2>
          <p className="field-hint">
            Started in the agent&rsquo;s own CLI. Opening one here continues it — the transcript is
            whatever the agent replays, and KiroChrome&rsquo;s own log starts from the moment you
            open it.
          </p>
          {listers.map((provider) => (
            <AgentConversations
              key={provider.id}
              provider={provider}
              onAdopt={onAdopt}
              onOpenSession={onOpenSession}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * One provider's own conversations, fetched on demand.
 *
 * On demand because listing spawns a probe agent on the server: doing it for
 * every verified provider on arrival would make the page cost several agent
 * startups before the user has asked for anything.
 *
 * Only rendered for providers that advertised `sessionCapabilities.list`, read
 * from the capabilities their setup check recorded — nothing here assumes which
 * agents can do this.
 */
function AgentConversations({
  provider,
  onAdopt,
  onOpenSession,
}: {
  provider: ProviderView;
  onAdopt: (providerId: string, target: AdoptTarget) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const [listed, setListed] = useState<AgentSessionsResponse | null>(null);
  const [error, setError] = useState<KcError | null>(null);

  // Listing is gated on `sessionCapabilities.list`; opening one is gated on the
  // separate top-level `loadSession`. An agent can advertise the first without
  // the second, and then the list is worth showing but not clickable.
  const canOpen = advertisesLoadSession(provider.lastCheck?.capabilities);

  const load = () => {
    setState("loading");
    setError(null);
    fetchAgentSessions(provider.id)
      .then((res) => {
        setListed(res);
        setState("done");
      })
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.kc : { code: "INTERNAL", message: String(err) },
        );
        setState("done");
      });
  };

  if (state === "idle") {
    return (
      <button className="chip" onClick={load}>
        Browse {provider.name}&rsquo;s conversations
      </button>
    );
  }
  if (state === "loading") {
    return <p className="muted">Asking {provider.name} what it has…</p>;
  }
  if (error) {
    return (
      <div className="banner">
        {error.message}
        {error.remediation && <p className="remediation">{error.remediation}</p>}
      </div>
    );
  }
  if (!listed || listed.sessions.length === 0) {
    return (
      <p className="muted">
        {listed?.supported === false
          ? `${provider.name} no longer offers session/list.`
          : `${provider.name} is not holding any conversations.`}
      </p>
    );
  }

  return (
    <div className="agent-sessions">
      {listed.sessions.map((info) => (
        <AgentConversationRow
          key={info.sessionId}
          info={info}
          canOpen={canOpen}
          heldBy={listed.adopted[info.sessionId]}
          onAdopt={() =>
            onAdopt(provider.id, {
              agentSessionId: info.sessionId,
              cwd: info.cwd,
              title: info.title,
            })
          }
          onOpenSession={onOpenSession}
        />
      ))}
      {listed.truncated && (
        <p className="muted">
          Only the most recent are shown; {provider.name} reported more than we fetch at once.
        </p>
      )}
    </div>
  );
}

function AgentConversationRow({
  info,
  canOpen,
  heldBy,
  onAdopt,
  onOpenSession,
}: {
  info: AgentSessionInfo;
  canOpen: boolean;
  /** Set when this agent session is already a KiroChrome conversation. */
  heldBy: string | undefined;
  onAdopt: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const label = info.title ?? info.sessionId;
  const when = info.updatedAt ? new Date(info.updatedAt).toLocaleString() : null;

  return (
    <button
      className="agent-session"
      disabled={!canOpen && heldBy === undefined}
      onClick={() => (heldBy !== undefined ? onOpenSession(heldBy) : onAdopt())}
    >
      <strong>{label}</strong>
      <span className="muted">{info.cwd}</span>
      <span className="muted">
        {heldBy !== undefined ? "Already open here" : when ?? "No date reported"}
      </span>
    </button>
  );
}
