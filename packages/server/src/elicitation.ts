import type {
  ElicitationChoice,
  ElicitationField,
  ElicitationValue,
} from "@kirochrome/shared";

/**
 * Turns ACP's elicitation schema into a flat list of fields.
 *
 * The protocol describes the form as a JSON Schema of primitive properties.
 * Interpreting that belongs on one side of the wire, not both: the browser gets
 * a list of typed fields and renders an input per entry, and nothing about JSON
 * Schema reaches `Chat.tsx`.
 *
 * Unknown property types are dropped. If a *required* property is one we cannot
 * render, the whole form is unsupported — answering it would mean returning
 * content that does not satisfy the schema the agent asked for.
 */
export type NormalisedForm =
  | { fields: ElicitationField[] }
  | { unsupported: { key: string; type: string } };

export function toFields(requestedSchema: unknown): NormalisedForm {
  const schema = asRecord(requestedSchema);
  const properties = asRecord(schema?.["properties"]) ?? {};
  const required = new Set(
    Array.isArray(schema?.["required"])
      ? (schema["required"] as unknown[]).filter((k): k is string => typeof k === "string")
      : [],
  );

  const fields: ElicitationField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const prop = asRecord(raw);
    if (!prop) continue;
    const field = toField(key, prop, required.has(key));
    if (field) {
      fields.push(field);
      continue;
    }
    if (required.has(key)) {
      return { unsupported: { key, type: String(prop["type"] ?? "unknown") } };
    }
  }
  return { fields };
}

function toField(
  key: string,
  prop: Record<string, unknown>,
  required: boolean,
): ElicitationField | null {
  const base = {
    key,
    label: str(prop["title"]) ?? key,
    description: str(prop["description"]),
    required,
  };

  switch (prop["type"]) {
    case "string": {
      // A string with choices is a picker, not a text box — which is the shape
      // the roadmap expected elicitation to have in the first place.
      const choices = stringChoices(prop);
      if (choices.length > 0) {
        return { ...base, type: "select", choices, default: str(prop["default"]) };
      }
      return {
        ...base,
        type: "text",
        default: str(prop["default"]),
        format: str(prop["format"]),
        minLength: num(prop["minLength"]),
        maxLength: num(prop["maxLength"]),
        pattern: str(prop["pattern"]),
      };
    }
    case "number":
    case "integer":
      return {
        ...base,
        type: "number",
        integer: prop["type"] === "integer",
        default: num(prop["default"]),
        minimum: num(prop["minimum"]),
        maximum: num(prop["maximum"]),
      };
    case "boolean":
      return { ...base, type: "boolean", default: bool(prop["default"]) };
    case "array": {
      const choices = itemChoices(asRecord(prop["items"]));
      // An array with no enumerable items is free-form, which the schema does
      // not describe well enough for us to render honestly.
      if (choices.length === 0) return null;
      return {
        ...base,
        type: "multiselect",
        choices,
        default: Array.isArray(prop["default"])
          ? (prop["default"] as unknown[]).filter((v): v is string => typeof v === "string")
          : undefined,
        minItems: num(prop["minItems"]),
        maxItems: num(prop["maxItems"]),
      };
    }
    default:
      return null;
  }
}

/** `enum` is the untitled form, `oneOf` the titled one. Agents may send either. */
function stringChoices(prop: Record<string, unknown>): ElicitationChoice[] {
  return [...plainChoices(prop["enum"]), ...titledChoices(prop["oneOf"])];
}

/** Multi-select spells the same two forms `enum` and `anyOf`. */
function itemChoices(items: Record<string, unknown> | null): ElicitationChoice[] {
  if (!items) return [];
  return [...plainChoices(items["enum"]), ...titledChoices(items["anyOf"])];
}

function plainChoices(value: unknown): ElicitationChoice[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => ({ value: v, label: v }));
}

function titledChoices(value: unknown): ElicitationChoice[] {
  if (!Array.isArray(value)) return [];
  const choices: ElicitationChoice[] = [];
  for (const raw of value) {
    const option = asRecord(raw);
    const constant = str(option?.["const"]);
    if (!option || constant === undefined) continue;
    choices.push({
      value: constant,
      label: str(option["title"]) ?? constant,
      description: str(option["description"]),
    });
  }
  return choices;
}

/**
 * Filters an answer down to what the schema actually asked for.
 *
 * The browser is not authoritative (invariant 3), so its reply is treated as a
 * proposal: unknown keys are dropped and values are coerced to the field's
 * type. A value that cannot be coerced is omitted rather than guessed at —
 * sending the agent a `"3"` where it asked for a number is worse than sending
 * nothing and letting it ask again.
 */
export function coerceContent(
  fields: ElicitationField[],
  raw: Record<string, unknown> | undefined,
): Record<string, ElicitationValue> {
  const content: Record<string, ElicitationValue> = {};
  if (!raw) return content;

  for (const field of fields) {
    const value = raw[field.key];
    if (value === undefined || value === null) continue;

    switch (field.type) {
      case "text": {
        const text = str(value);
        if (text !== undefined) content[field.key] = text;
        break;
      }
      case "number": {
        // Number inputs arrive as strings from a form, so accept both.
        const parsed = typeof value === "string" ? Number(value) : num(value);
        if (parsed === undefined || !Number.isFinite(parsed)) break;
        if (field.integer && !Number.isInteger(parsed)) break;
        content[field.key] = parsed;
        break;
      }
      case "boolean": {
        const flag = bool(value);
        if (flag !== undefined) content[field.key] = flag;
        break;
      }
      case "select": {
        const choice = str(value);
        if (choice !== undefined && field.choices.some((c) => c.value === choice)) {
          content[field.key] = choice;
        }
        break;
      }
      case "multiselect": {
        if (!Array.isArray(value)) break;
        const allowed = value.filter(
          (v): v is string => typeof v === "string" && field.choices.some((c) => c.value === v),
        );
        content[field.key] = allowed;
        break;
      }
    }
  }
  return content;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
