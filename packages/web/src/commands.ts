import type { SlashCommand } from "@kirochrome/shared";

export interface Completion {
  /** What the picker shows. */
  label: string;
  detail: string;
  hint?: string | undefined;
  /** The whole composer value if this is chosen. */
  replacement: string;
}

/**
 * Terminal-style completion for the composer.
 *
 * Two phases, like a shell: completing the command name, then completing its
 * argument. Argument values are read from the command's own `hint` when it
 * enumerates them (`low|medium|high`), which is how ACP agents describe a
 * fixed set without a dedicated protocol for it.
 */
export function complete(draft: string, commands: SlashCommand[]): Completion[] {
  const name = /^\/(\S*)$/.exec(draft);
  if (name) {
    const typed = name[1] ?? "";
    return commands
      .filter((c) => c.name.startsWith(typed))
      .map((c) => ({
        label: `/${c.name}`,
        detail: c.description,
        hint: c.input?.hint ?? undefined,
        replacement: `/${c.name}${c.input ? " " : ""}`,
      }));
  }

  const withArg = /^\/(\S+)\s+(\S*)$/.exec(draft);
  if (!withArg) return [];

  const command = commands.find((c) => c.name === withArg[1]);
  const typedArg = withArg[2] ?? "";
  return enumerated(command?.input?.hint)
    .filter((value) => value.startsWith(typedArg))
    .map((value) => ({
      label: value,
      detail: `/${command!.name}`,
      replacement: `/${command!.name} ${value}`,
    }));
}

/**
 * Values a hint enumerates, if it does.
 *
 * `low|medium|high` is a choice list; `query to search for` is prose. Requiring
 * a separator and short, single-word values keeps prose out.
 */
function enumerated(hint: string | null | undefined): string[] {
  if (!hint) return [];
  const parts = hint
    .replace(/[<>[\]{}()]/g, "")
    .split(/[|,/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return [];
  return parts.every((p) => /^[\w.:-]{1,24}$/.test(p)) ? parts : [];
}

/**
 * The longest prefix every candidate shares — what a shell completes to when
 * Tab is ambiguous, rather than picking one for you.
 */
export function commonPrefix(values: string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
