import { useCallback, useEffect, useState } from "react";
import { CHECK_STAGES } from "@kirochrome/shared";
import type { CheckStage, ProviderCheckResult, ProviderView } from "@kirochrome/shared";
import { ApiError, fetchProviders, runCheck } from "./api.js";
import { applyTheme, loadTheme, type Theme } from "./theme.js";

export function Setup() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const { providers } = await fetchProviders();
      setProviders(providers);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.kc.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const check = useCallback(async (id: string) => {
    setRunning((prev) => new Set(prev).add(id));
    try {
      const { result } = await runCheck(id);
      setProviders((prev) =>
        prev?.map((p) => (p.id === id ? { ...p, lastCheck: result } : p)) ?? prev,
      );
    } catch (err) {
      const message = err instanceof ApiError ? err.kc.message : String(err);
      setLoadError(message);
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const ready = providers?.filter((p) => p.lastCheck?.status === "ok").length ?? 0;

  return (
    <div className="page">
      <header className="header">
        <h1>Setup</h1>
        <p className="subtitle">
          Verify each agent before you rely on it. A provider must pass every rung before it can
          be used for a new chat.
        </p>
        {providers && (
          <p className="tally">
            {ready} of {providers.length} provider{providers.length === 1 ? "" : "s"} ready
          </p>
        )}
      </header>

      {loadError && <div className="banner">{loadError}</div>}

      <ThemePicker />

      {!providers && !loadError && <p className="muted">Loading providers…</p>}

      <div className="cards">
        {providers?.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            running={running.has(provider.id)}
            onCheck={() => void check(provider.id)}
          />
        ))}
      </div>
    </div>
  );
}

const THEMES: Array<{ value: Theme; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(loadTheme);

  const choose = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <section className="theme">
      <h2 className="section-label">Appearance</h2>
      <div className="segmented" role="group" aria-label="Theme">
        {THEMES.map((option) => (
          <button
            key={option.value}
            className={theme === option.value ? "on" : ""}
            aria-pressed={theme === option.value}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  provider,
  running,
  onCheck,
}: {
  provider: ProviderView;
  running: boolean;
  onCheck: () => void;
}) {
  const check = provider.lastCheck;
  const status = running ? "running" : (check?.status ?? "unchecked");

  return (
    <section className={`card status-${status}`}>
      <div className="card-head">
        <div>
          <h2>{provider.name}</h2>
          <code className="cmd">
            {provider.command} {provider.args.join(" ")}
          </code>
        </div>
        <div className="card-actions">
          <StatusPill status={status} />
          <button onClick={onCheck} disabled={running}>
            {running ? "Checking…" : check ? "Re-check" : "Check"}
          </button>

        </div>
      </div>

      <Ladder result={check} running={running} />

      {check?.error && (
        <div className="error">
          <div className="error-head">
            <span className="code">{check.error.code}</span>
            <span>{check.error.message}</span>
          </div>
          {check.error.remediation && <p className="remediation">{check.error.remediation}</p>}
          <Details label="Error detail" json={check.error.detail} />
          {check.error.cause && <Details label="Cause" text={check.error.cause} />}
        </div>
      )}

      {check?.status === "ok" && <Capabilities result={check} />}

      {/* The agent's stdout is JSON-RPC; when it misbehaves, the reason is here. */}
      {check?.stderrTail && <Details label="Agent stderr" text={check.stderrTail} />}

      {check && (
        <p className="muted timestamp">
          Checked {new Date(check.checkedAt).toLocaleString()} · {check.durationMs}ms
        </p>
      )}
    </section>
  );
}

/** The check ladder, showing exactly which rung was reached. */
function Ladder({ result, running }: { result: ProviderCheckResult | null; running: boolean }) {
  const outcome = (stage: CheckStage) => result?.stages.find((s) => s.stage === stage);

  return (
    <ol className="ladder">
      {CHECK_STAGES.map((stage) => {
        const done = outcome(stage);
        const state = running && !done ? "pending" : !done ? "skipped" : done.ok ? "ok" : "failed";
        return (
          <li key={stage} className={`rung rung-${state}`}>
            <span className="rung-mark">{state === "ok" ? "✓" : state === "failed" ? "✗" : "·"}</span>
            <span className="rung-name">{stage}</span>
            {done && <span className="rung-ms">{done.ms}ms</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Capabilities({ result }: { result: ProviderCheckResult }) {
  return (
    <div className="ok-detail">
      <dl>
        <dt>Agent</dt>
        <dd>
          {result.agentInfo?.title ?? result.agentInfo?.name ?? "unknown"}
          {result.agentInfo?.version ? ` ${result.agentInfo.version}` : ""}
        </dd>
        <dt>Protocol</dt>
        <dd>ACP v{result.protocolVersion}</dd>
      </dl>
      <Details label="Config options (composer pickers)" json={result.configOptions} />
      <Details label="Modes" json={result.modes} />
      <Details label="Capabilities" json={result.capabilities} />
    </div>
  );
}

function Details({ label, json, text }: { label: string; json?: unknown; text?: string }) {
  const body = text ?? (json == null ? null : JSON.stringify(json, null, 2));
  if (!body) return null;
  return (
    <details className="details">
      <summary>{label}</summary>
      <pre>{body}</pre>
    </details>
  );
}

const LABELS: Record<string, string> = {
  ok: "Ready",
  failed: "Failed",
  stale: "Needs re-check",
  unchecked: "Not checked",
  running: "Checking",
};

const StatusPill = ({ status }: { status: string }) => (
  <span className={`pill pill-${status}`}>{LABELS[status] ?? status}</span>
);
