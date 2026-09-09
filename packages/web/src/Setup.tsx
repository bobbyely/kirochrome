import { useCallback, useEffect, useState } from "react";
import { CHECK_STAGES } from "@kirochrome/shared";
import type { CheckStage, HostPlatform, ProviderCheckResult, ProviderView } from "@kirochrome/shared";
import { ApiError, fetchProviders, runCheck, updateProvider } from "./api.js";
import { applyTheme, effectiveTheme, loadTheme, type Theme } from "./theme.js";

export function Setup() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [platform, setPlatform] = useState<HostPlatform>("other");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const { providers, platform } = await fetchProviders();
      setProviders(providers);
      setPlatform(platform);
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
      <Shortcuts />

      {!providers && !loadError && <p className="muted">Loading providers…</p>}

      <div className="cards">
        {providers?.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            running={running.has(provider.id)}
            platform={platform}
            onCheck={() => void check(provider.id)}
            onReload={load}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A switch rather than three buttons.
 *
 * "System" is still honoured — it is simply the starting state rather than a
 * third position. Flicking the switch makes an explicit choice; "follow system"
 * hands control back, and only appears once there is something to hand back.
 */
function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const dark = effectiveTheme(theme) === "dark";

  const choose = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <section className="theme">
      <h2 className="section-label">Appearance</h2>
      <div className="theme-row">
        <button
          type="button"
          role="switch"
          aria-checked={dark}
          aria-label="Dark mode"
          className={`switch ${dark ? "on" : ""}`}
          onClick={() => choose(dark ? "light" : "dark")}
        >
          <span className="switch-track">
            <span className="switch-knob" />
          </span>
          <span className="switch-label">{dark ? "Dark" : "Light"}</span>
        </button>

        {theme !== "system" && (
          <button className="setup-link" onClick={() => choose("system")}>
            Follow system
          </button>
        )}
      </div>
    </section>
  );
}

/** Per-platform install hints. Only ever suggestions — never run for the user. */
const INSTALL_HINTS: Record<string, Partial<Record<HostPlatform, string>>> = {
  kiro: {
    darwin: "brew install kiro-cli   # or see https://kiro.dev/docs/cli",
    linux: "curl -fsSL https://kiro.dev/install.sh | bash",
    win32: "See https://kiro.dev/docs/cli for Windows install steps",
  },
  "claude-code": {
    darwin: "npm install -g @anthropic-ai/claude-code",
    linux: "npm install -g @anthropic-ai/claude-code",
    win32: "npm install -g @anthropic-ai/claude-code",
  },
};

/**
 * What to do when a binary is not found: where it commonly lives, how to
 * install it, and a field to point at it directly.
 *
 * GUI-launched processes often do not inherit a shell PATH, so an absolute
 * path is frequently the actual fix rather than installing anything.
 */
function NotFoundHelp({
  provider,
  platform,
  onReload,
}: {
  provider: ProviderView;
  platform: HostPlatform;
  onReload: () => Promise<void>;
}) {
  const [path, setPath] = useState(provider.command);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hint = INSTALL_HINTS[provider.id]?.[platform];

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await updateProvider(provider.id, { command: path });
      await onReload();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.kc.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="notfound">
      {hint && (
        <>
          <p className="notfound-label">Install it</p>
          <pre className="notfound-cmd">{hint}</pre>
        </>
      )}
      <p className="notfound-label">Or point at it directly</p>
      <div className="notfound-row">
        <input
          value={path}
          spellCheck={false}
          placeholder="/absolute/path/to/binary"
          onChange={(e) => setPath(e.target.value)}
        />
        <button onClick={() => void save()} disabled={saving || !path.trim()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="field-hint">
        Common locations: <code>~/.local/bin/</code>, <code>/usr/local/bin/</code>,
        <code> /opt/homebrew/bin/</code>
      </p>
      {saveError && <p className="remediation">{saveError}</p>}
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["⌘/Ctrl + K", "Search conversations"],
  ["⌘/Ctrl + ⇧ + O", "New chat"],
  ["Alt + ↑ / ↓", "Previous / next conversation"],
  ["Enter", "Send · ⇧ Enter for a newline"],
];

function Shortcuts() {
  return (
    <section className="theme">
      <h2 className="section-label">Keyboard</h2>
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}>
            <dt><kbd>{keys}</kbd></dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ProviderCard({
  provider,
  running,
  platform,
  onCheck,
  onReload,
}: {
  provider: ProviderView;
  running: boolean;
  platform: HostPlatform;
  onCheck: () => void;
  onReload: () => Promise<void>;
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
          {check.error.code === "AGENT_NOT_FOUND" && (
            <NotFoundHelp provider={provider} platform={platform} onReload={onReload} />
          )}
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
