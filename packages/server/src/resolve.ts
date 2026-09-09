import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Resolves a command to an executable path, the way a shell would.
 *
 * We do this ourselves rather than shelling out to `which` so the failure can
 * report *which* paths were tried — the difference between "not found" and an
 * actionable error.
 */
export function resolveCommand(command: string, extraPath?: string): { path: string } | { tried: string[] } {
  const candidates = command.includes("/") || command.includes("\\")
    ? [command]
    : searchPath(command, extraPath);

  const tried: string[] = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    if (isExecutable(candidate)) return { path: candidate };
  }
  return { tried };
}

function searchPath(command: string, extraPath?: string): string[] {
  const path = [extraPath, process.env.PATH].filter(Boolean).join(delimiter);
  const dirs = path.split(delimiter).filter((d) => d.length > 0);
  // On Windows a bare name may be a .cmd/.exe shim rather than the literal name.
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  return dirs.flatMap((dir) => suffixes.map((suffix) => join(dir, command + suffix)));
}

function isExecutable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const looksAbsolute = (command: string) => isAbsolute(command);
