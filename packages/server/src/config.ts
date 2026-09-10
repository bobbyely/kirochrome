import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { causeOf, kcError, type ProviderConfig } from "@kirochrome/shared";
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
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      install: {
        darwin: "npm install -g @anthropic-ai/claude-code",
        linux: "npm install -g @anthropic-ai/claude-code",
        win32: "npm install -g @anthropic-ai/claude-code",
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
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp"],
      install: {
        darwin: "npm install -g @openai/codex",
        linux: "npm install -g @openai/codex",
        win32: "npm install -g @openai/codex",
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
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
    const seeded: AppConfig = { providers: defaultProviders() };
    writeConfig(seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(raw) as AppConfig;
    if (!Array.isArray(parsed.providers)) {
      throw kcError("CONFIG_INVALID", `${path} has no 'providers' array.`);
    }
    return parsed;
  } catch (err) {
    throw kcError("CONFIG_INVALID", `Could not read ${path}.`, { cause: causeOf(err) });
  }
}
