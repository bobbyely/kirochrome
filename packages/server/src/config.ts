import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { causeOf, kcError, type ProviderConfig, type Validated } from "@kirochrome/shared";
import { configPath, dataDir } from "./paths.js";

/**
 * Seed providers. These are starting points, not a hardcoded catalogue — the
 * user edits config.json, and a provider's models/modes always come from the
 * protocol, never from here.
 *
 * Not all of these have been run end to end; docs/PROVIDERS.md says which. A
 * seed that turns out to be wrong fails at a named rung on the setup page with
 * an editable command, which is the whole point of the check ladder.
 */
function defaultProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [
    {
      id: "kiro",
      name: "Kiro CLI",
      command: "kiro-cli",
      args: ["acp"],
      install: {
        darwin: "brew install kiro-cli   # or see https://kiro.dev/docs/cli",
        linux: "curl -fsSL https://kiro.dev/install.sh | bash",
        win32: "See https://kiro.dev/docs/cli for Windows install steps",
      },
      docsUrl: "https://kiro.dev/docs/cli/acp/",
    },
    {
      id: "claude-code",
      name: "Claude Code",
      // The installed binary, not `npx -y ...`. See the npx gotcha: the wrapper
      // re-resolves the package on every spawn and can spend the whole
      // handshake budget before the agent starts.
      command: "claude-agent-acp",
      args: [],
      install: {
        darwin: "npm install -g @agentclientprotocol/claude-agent-acp",
        linux: "npm install -g @agentclientprotocol/claude-agent-acp",
        win32: "npm install -g @agentclientprotocol/claude-agent-acp",
      },
      docsUrl: "https://github.com/anthropics/claude-code",
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini",
      // `--experimental-acp` is deprecated in favour of `--acp`; verified
      // against @google/gemini-cli 0.59.0.
      args: ["--acp"],
      install: {
        darwin: "npm install -g @google/gemini-cli",
        linux: "npm install -g @google/gemini-cli",
        win32: "npm install -g @google/gemini-cli",
      },
      docsUrl: "https://github.com/google-gemini/gemini-cli",
    },
    {
      id: "codex",
      name: "Codex",
      command: "codex-acp",
      args: [],
      install: {
        darwin: "npm install -g @zed-industries/codex-acp",
        linux: "npm install -g @zed-industries/codex-acp",
        win32: "npm install -g @zed-industries/codex-acp",
      },
      docsUrl: "https://github.com/zed-industries/codex-acp",
    },
  ];

  // When running from a checkout, seed the offline mock too, so a first run has
  // at least one provider that is guaranteed to pass.
  const mock = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "spike", "mock-agent.mjs");
  if (existsSync(mock)) {
    providers.push({ id: "mock", name: "Mock Agent (offline)", command: process.execPath, args: [mock] });
  }
  return providers;
}

export interface AppConfig {
  providers: ProviderConfig[];
  /**
   * Entries the file asked for and did not get: one line per dropped provider,
   * naming the index and what was wrong. Reported rather than obeyed.
   */
  problems: string[];
}

/** Persists an edit to one provider, leaving the rest of the file alone. */
export function updateProvider(id: string, patch: Partial<ProviderConfig>): AppConfig {
  const config = loadConfig();
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) throw kcError("PROVIDER_UNKNOWN", `No provider configured with id '${id}'.`);

  Object.assign(provider, patch);
  try {
    writeConfig(config);
  } catch (err) {
    throw kcError("CONFIG_INVALID", `Could not write ${configPath()}.`, { cause: causeOf(err) });
  }
  return config;
}

/**
 * Writes the config and keeps it private.
 *
 * `writeFileSync`'s `mode` only applies when creating a file, so an update to
 * an existing one silently keeps its old permissions. This file can hold `env`
 * values, so chmod explicitly.
 */
function writeConfig(config: AppConfig): void {
  const path = configPath();
  // Only the providers: `problems` is this run's reading of the file, not part
  // of its schema, and writing it back would make it look user-editable.
  writeFileSync(path, `${JSON.stringify({ providers: config.providers }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort; Windows and some filesystems have no equivalent.
  }
}

export function loadConfig(): AppConfig {
  mkdirSync(dataDir(), { recursive: true });
  const path = configPath();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    const seeded: AppConfig = { providers: defaultProviders(), problems: [] };
    writeConfig(seeded);
    return seeded;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw kcError("CONFIG_INVALID", `${path} is not valid JSON.`, { cause: causeOf(err) });
  }

  const config = validateConfig(parsed, path);
  // stderr, because it is the channel AGENTS.md points you at first and the one
  // place a problem is visible without a page open.
  for (const problem of config.problems) console.warn(`config.json: ${problem}`);
  return config;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validates a hand-edited config file.
 *
 * **A bad entry is dropped, not fatal.** This file is edited by hand and holds
 * every route back into the app: refusing the whole file over one mistyped
 * `args` would take away the setup page that is the only way to fix it. So a
 * broken provider is reported and skipped, and the working ones still load.
 *
 * The file is rejected only when nothing survives it — not an object, no
 * `providers` array, or every entry invalid. Then the typed error names each
 * problem, which beats an empty provider list that explains nothing.
 */
function validateConfig(value: unknown, path: string): AppConfig {
  if (!isRecord(value)) throw kcError("CONFIG_INVALID", `${path} must contain a JSON object.`);
  if (!Array.isArray(value.providers)) throw kcError("CONFIG_INVALID", `${path} has no 'providers' array.`);

  const providers: ProviderConfig[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  value.providers.forEach((entry: unknown, i: number) => {
    const checked = validateProvider(entry);
    if (!checked.ok) {
      problems.push(`ignored providers[${i}] — ${checked.problem}`);
      return;
    }
    // `find(p => p.id === …)` takes the first match everywhere, so a second
    // entry with the same id is dead weight that looks like it is in use.
    if (seen.has(checked.value.id)) {
      problems.push(`ignored providers[${i}] — duplicate id '${checked.value.id}'`);
      return;
    }
    seen.add(checked.value.id);
    providers.push(checked.value);
  });

  // An empty array is a legitimately empty registry; entries that all failed
  // are a broken file, and saying so is the whole point.
  if (providers.length === 0 && problems.length > 0) {
    throw kcError("CONFIG_INVALID", `${path} defines no usable provider: ${problems.join("; ")}.`, {
      detail: { problems },
    });
  }
  return { providers, problems };
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStringMap = (v: unknown): boolean =>
  isRecord(v) && Object.values(v).every((entry) => typeof entry === "string");

function validateProvider(value: unknown): Validated<ProviderConfig> {
  if (!isRecord(value)) return { ok: false, problem: "must be an object" };

  for (const key of ["id", "name", "command"] as const) {
    if (!isNonEmptyString(value[key])) return { ok: false, problem: `'${key}' must be a non-empty string` };
  }
  // Omitting args is the common hand-written shape, and "no arguments" is what
  // it obviously means. A wrong *type* is a mistake and is not guessed at.
  if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((a) => typeof a === "string"))) {
    return { ok: false, problem: "'args' must be an array of strings" };
  }
  for (const key of ["cwd", "authMethodId", "docsUrl"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return { ok: false, problem: `'${key}' must be a string` };
    }
  }
  for (const key of ["env", "install"] as const) {
    if (value[key] !== undefined && !isStringMap(value[key])) {
      return { ok: false, problem: `'${key}' must be an object of strings` };
    }
  }

  // Every field read anywhere has been checked above, so this narrows rather
  // than asserts. `args` is the one defaulted field.
  const provider = { ...value, args: value.args ?? [] } as unknown as ProviderConfig;
  return { ok: true, value: provider };
}
