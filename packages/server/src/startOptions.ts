import type { StartOptions } from "@kirochrome/shared";

/**
 * A browser form's StartOptions, kept to the two fields with their proper
 * types. Forms send whatever they hold; only strings and booleans by id, and
 * a non-empty opening line, survive.
 */
export function cleanStart(start: unknown): StartOptions {
  if (typeof start !== "object" || start === null) return {};
  const raw = start as { configValues?: unknown; opening?: unknown };
  const configValues: Record<string, string | boolean> = {};
  if (typeof raw.configValues === "object" && raw.configValues !== null) {
    for (const [k, v] of Object.entries(raw.configValues)) {
      if (typeof v === "string" || typeof v === "boolean") configValues[k] = v;
    }
  }
  const opening = typeof raw.opening === "string" ? raw.opening.trim() : "";
  return {
    ...(Object.keys(configValues).length ? { configValues } : {}),
    ...(opening ? { opening } : {}),
  };
}
