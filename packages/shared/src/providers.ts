import type { CheckStage, KcError } from "./errors.js";

/**
 * A provider is just "which binary to spawn". Everything else about an agent —
 * its models, modes, capabilities — comes from the protocol at runtime and is
 * never hardcoded here.
 */
export interface ProviderConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** Working directory for the agent process. Defaults to the server's cwd. */
  cwd?: string;
  /** Extra environment for the child, merged over the server's own. */
  env?: Record<string, string>;
  /** Chosen ACP auth method id, once the user has picked one. */
  authMethodId?: string;
  /**
   * Per-platform install suggestion, shown when the binary is not found.
   * Lives here rather than in the UI so a provider added to config.json can
   * carry its own hint — the setup page renders whatever it is given.
   *
   * Only ever displayed. We never run it for the user.
   */
  install?: Partial<Record<HostPlatform, string>>;
  /** Where to read about this agent, shown alongside the install hint. */
  docsUrl?: string;
}

export type ProviderStatus = "ok" | "failed" | "stale" | "unchecked";

export interface StageOutcome {
  stage: CheckStage;
  ok: boolean;
  ms: number;
}

/** An ACP authentication method, as advertised by the agent. */
export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

/**
 * The result of running the check ladder. Deliberately records *which rung*
 * was reached rather than a bare boolean — that is the whole point.
 */
export interface ProviderCheckResult {
  providerId: string;
  status: ProviderStatus;
  /** The rung reached: the last one attempted, whether it passed or failed. */
  stage: CheckStage | null;
  stages: StageOutcome[];
  error?: KcError;
  /** Populated on success — what the agent told us about itself. */
  /** Nullable fields mirror the ACP schema, which uses null rather than omission. */
  agentInfo?: { name?: string; title?: string | null; version?: string | null };
  protocolVersion?: number;
  capabilities?: unknown;
  authMethods?: AuthMethod[];
  /** What the composer's pickers would render, in whichever dialect the agent speaks. */
  configOptions?: unknown;
  modes?: unknown;
  /** Tail of the agent's stderr. The highest-value debugging artefact we have. */
  stderrTail?: string;
  checkedAt: number;
  durationMs: number;
}

export interface ProviderView extends ProviderConfig {
  lastCheck: ProviderCheckResult | null;
}

/** Where the server ran, so the UI can suggest the right install command. */
export type HostPlatform = "darwin" | "linux" | "win32" | "other";

/** HTTP API payloads. */
export interface ProvidersResponse {
  providers: ProviderView[];
  platform: HostPlatform;
}

export interface UpdateProviderRequest {
  command?: string;
  args?: string[];
}
export interface CheckResponse {
  result: ProviderCheckResult;
}
export interface ApiErrorResponse {
  error: KcError;
}
