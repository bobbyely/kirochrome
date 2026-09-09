import type { ConfigOption } from "@kirochrome/shared";

/**
 * Normalises an agent's `session/new` response into one list of selectable
 * options.
 *
 * ACP is mid-migration: newer agents return generic `configOptions`, older ones
 * return `availableModels` and a `modes` state. Kiro currently documents the
 * older pair. Normalising here means the UI renders one shape and neither the
 * UI nor anything downstream branches per agent.
 */
/**
 * A readable label for an option that arrived with only an id.
 *
 * Kiro advertises its agents as modes, with ids like `kirocrew-conductor` and
 * `kiro_default`, and does not always send a display name. Rendering the raw id
 * is unhelpful; this is presentation only and never changes the value sent back.
 */
function humanise(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function normaliseConfigOptions(response: Record<string, unknown>): ConfigOption[] {
  const modern = response["configOptions"];
  const options: ConfigOption[] = Array.isArray(modern) ? ([...modern] as ConfigOption[]) : [];
  // Agents mid-migration emit both dialects, and not always with the same
  // settings in each. Merge legacy entries the modern list does not cover
  // rather than letting one silently hide the other.
  const has = (id: string) => options.some((o) => o.id === id);

  const models = (response["models"] ?? response["availableModels"]) as
    | { currentModelId?: string; availableModels?: Array<{ modelId?: string; id?: string; name?: string; description?: string }> }
    | Array<{ modelId?: string; id?: string; name?: string; description?: string }>
    | undefined;
  const modelList = Array.isArray(models) ? models : models?.availableModels;
  if (modelList?.length && !has("model")) {
    const current = Array.isArray(models) ? undefined : models?.currentModelId;
    options.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current ?? modelList[0]?.modelId ?? modelList[0]?.id ?? "",
      options: modelList.map((m) => ({
        value: m.modelId ?? m.id ?? "",
        name: m.name ?? humanise(m.modelId ?? m.id ?? ""),
        ...(m.description ? { description: m.description } : {}),
      })),
    });
  }

  const modes = response["modes"] as
    | { currentModeId?: string; availableModes?: Array<{ id: string; name?: string; description?: string }> }
    | undefined;
  if (modes?.availableModes?.length && !has("mode")) {
    options.push({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId ?? modes.availableModes[0]?.id ?? "",
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name ?? humanise(m.id),
        ...(m.description ? { description: m.description } : {}),
      })),
    });
  }

  return options;
}
