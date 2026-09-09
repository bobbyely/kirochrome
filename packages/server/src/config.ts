import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { causeOf, kcError, type ProviderConfig } from "@kirochrome/shared";
import { configPath, dataDir } from "./paths.js";

/**
 * Seed providers. These are starting points, not a hardcoded catalogue — the
 * user edits config.json, and a provider's models/modes always come from the
 * protocol, never from here.
 */
const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "kiro",
    name: "Kiro CLI",
    command: "kiro-cli",
    args: ["acp"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  },
];

export interface AppConfig {
  providers: ProviderConfig[];
}

export function loadConfig(): AppConfig {
  mkdirSync(dataDir(), { recursive: true });
  const path = configPath();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    const seeded: AppConfig = { providers: DEFAULT_PROVIDERS };
    writeFileSync(path, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });
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
