import { homedir } from "node:os";
import { join } from "node:path";

/** Per-OS application data directory. */
export function dataDir(): string {
  if (process.env.KIROCHROME_DATA_DIR) return process.env.KIROCHROME_DATA_DIR;

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "kirochrome");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "kirochrome");
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdg, "kirochrome");
}

export const dbPath = () => join(dataDir(), "kirochrome.db");
export const configPath = () => join(dataDir(), "config.json");
