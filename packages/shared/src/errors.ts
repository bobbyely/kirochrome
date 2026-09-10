/**
 * The closed error vocabulary. Every failure in KiroChrome is one of these
 * codes — never a bare string — so the UI can render remediation and we can
 * tell "the binary is missing" apart from "the agent is logged out".
 */
export const KC_ERROR_CODES = [
  "AGENT_NOT_FOUND",
  "AGENT_SPAWN_FAILED",
  "AGENT_EXITED",
  "AGENT_HANDSHAKE_TIMEOUT",
  "AGENT_PROTOCOL_MISMATCH",
  "AGENT_AUTH_REQUIRED",
  "AGENT_SESSION_FAILED",
  "RPC_TIMEOUT",
  "RPC_ERROR",
  "SESSION_NOT_LIVE",
  "SESSION_UNKNOWN",
  "PROVIDER_UNKNOWN",
  "CONFIG_INVALID",
  "MESSAGE_INVALID",
  "INTERNAL",
] as const;

export type KcErrorCode = (typeof KC_ERROR_CODES)[number];

/** Rungs of the setup check ladder, in the order they are attempted. */
export const CHECK_STAGES = [
  "resolve",
  "spawn",
  "initialize",
  "version",
  "authenticate",
  "session",
  "capabilities",
] as const;

export type CheckStage = (typeof CHECK_STAGES)[number];

export interface KcError {
  code: KcErrorCode;
  /** Which rung failed, when the error came from a check. */
  stage?: CheckStage;
  /** What happened. */
  message: string;
  /** What the user should do about it. */
  remediation?: string;
  /** Structured context — paths tried, exit codes, JSON-RPC data. */
  detail?: unknown;
  /** The underlying error, preserved. Never discard this. */
  cause?: string;
}

/**
 * Default remediation per code. Callers may override with something more
 * specific (e.g. naming the exact path that was tried).
 */
export const REMEDIATION: Record<KcErrorCode, string> = {
  AGENT_NOT_FOUND:
    "Check the command path in your provider config. GUI apps often do not inherit your shell PATH, so prefer an absolute path.",
  AGENT_SPAWN_FAILED:
    "The command was found but would not start. Try running it yourself in a terminal to see what it prints.",
  AGENT_EXITED:
    "The agent exited unexpectedly. Check the stderr output below for the cause.",
  AGENT_HANDSHAKE_TIMEOUT:
    "The agent started but never completed the ACP handshake. Confirm the command really starts an ACP server (for Kiro that is `kiro-cli acp`). If it is wrapped in `npx`, that is the likely cause: npx re-resolves the package against the registry on every spawn and can use the whole timeout before the agent runs. Install the agent and point at its binary instead.",
  AGENT_PROTOCOL_MISMATCH:
    "This agent speaks an ACP version we do not support. Update the agent, or update KiroChrome.",
  AGENT_AUTH_REQUIRED:
    "The agent needs you to log in before it will start a session. Use one of the authentication methods listed below.",
  AGENT_SESSION_FAILED:
    "The handshake succeeded but the agent refused to open a session. The stderr output below usually explains why.",
  RPC_TIMEOUT: "The agent stopped responding. Re-run the check, and restart the agent if it persists.",
  RPC_ERROR: "The agent returned an error. See the details below.",
  SESSION_NOT_LIVE:
    "No agent is attached to this conversation — it was restored from disk, or its agent exited. The transcript is readable; use 'Resume conversation' to continue it.",
  SESSION_UNKNOWN: "That conversation no longer exists.",
  PROVIDER_UNKNOWN: "No provider is configured with that id. Check your config file.",
  CONFIG_INVALID: "The configuration file could not be read. Fix or delete it to regenerate defaults.",
  MESSAGE_INVALID:
    "The browser sent a message this server does not understand. Reload the page; if it keeps happening, the page and the server are different versions.",
  INTERNAL: "An unexpected internal error. Please report this with the details below.",
};

/**
 * Codes that indicate the *provider* is wrong, rather than this particular
 * conversation. These mark a provider stale so it drops out of the new-chat
 * list until re-checked, and the UI offers a route back to Setup.
 */
export const PROVIDER_FAULT_CODES = new Set<KcErrorCode>([
  "AGENT_NOT_FOUND",
  "AGENT_SPAWN_FAILED",
  "AGENT_HANDSHAKE_TIMEOUT",
  "AGENT_PROTOCOL_MISMATCH",
  "AGENT_AUTH_REQUIRED",
]);

export const isProviderFault = (code: KcErrorCode | undefined): boolean =>
  code !== undefined && PROVIDER_FAULT_CODES.has(code);

/** Builds a KcError, defaulting the remediation from the code. */
export function kcError(
  code: KcErrorCode,
  message: string,
  extra: Omit<Partial<KcError>, "code" | "message"> = {},
): KcError {
  return { code, message, remediation: REMEDIATION[code], ...extra };
}

/** Normalises an unknown thrown value into a preserved `cause` string. */
export function causeOf(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
