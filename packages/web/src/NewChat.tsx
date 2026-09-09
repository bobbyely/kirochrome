import { useEffect, useMemo, useState } from "react";
import type { ProviderView } from "@kirochrome/shared";
import { ApiError, fetchProviders } from "./api.js";
import { useChat } from "./useChat.js";

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
  onNeedsSetup,
}: {
  onStart: (providerId: string, cwd: string) => void;
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
    </div>
  );
}
