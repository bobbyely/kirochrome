import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { causeOf, kcError, type ProviderConfig } from "@kirochrome/shared";
import { configPath, dataDir } from "./paths.js";

/**
 * Seed providers. These are starting points, not a hardcoded catalogue — the
 * user edits config.json, and a provider's models/modes always come from the
 * protocol, never from here.
 */
function defaultProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [
    { id: "kiro", name: "Kiro CLI", command: "kiro-cli", args: ["acp"] },
    {
      id: "claude-code",
      name: "Claude Code",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
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

export function loadConfig(): AppConfig {
  mkdirSync(dataDir(), { recursive: true });
  const path = configPath();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    const seeded: AppConfig = { providers: defaultProviders() };
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
