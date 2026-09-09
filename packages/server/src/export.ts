import type { KcEvent, SessionRecord } from "@kirochrome/shared";

/**
 * Renders a conversation as Markdown.
 *
 * A pure function of the log and the session row, so an export is reproducible
 * and needs no live agent.
 */
export function toMarkdown(record: SessionRecord, events: KcEvent[]): string {
  const lines: string[] = [
    `# ${record.title ?? "Conversation"}`,
    "",
    `- **Agent:** ${record.providerName}`,
    `- **Directory:** \`${record.cwd}\``,
    `- **Started:** ${new Date(record.createdAt).toISOString()}`,
    "",
    "---",
    "",
  ];

  // Tool calls fold by id, exactly as the UI does, so the export reads like
  // the transcript rather than like the raw log.
  const toolTitles = new Map<string, string>();

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        lines.push(`## You`, "", event.text, "");
        break;

      case "agent_text":
        lines.push(`## ${record.providerName}`, "", event.text, "");
        break;

      case "tool_call":
        toolTitles.set(event.toolCallId, event.title);
        lines.push(`> **${event.kind}** · ${event.title}`, "");
        break;

      case "tool_call_update": {
        const diffs = collectDiffs(event.raw);
        for (const diff of diffs) {
          lines.push(`<details><summary>${diff.path}</summary>`, "", "```diff", diff.body, "```", "", "</details>", "");
        }
        break;
      }

      case "permission_request":
        lines.push(`> ⚠️ Permission requested: ${event.title}`, "");
        break;

      case "permission_resolved":
        lines.push(`> Answered: ${event.optionId ?? event.outcome}`, "");
        break;

      case "error":
        lines.push(`> ❌ **${event.error.code}** — ${event.error.message}`, "");
        break;

      case "agent_exited":
        lines.push(`> Agent exited (${event.signal ?? `code ${event.code}`})`, "");
        break;

      // turn markers and state updates carry no transcript content
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function collectDiffs(raw: unknown): Array<{ path: string; body: string }> {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];

  const diffs: Array<{ path: string; body: string }> = [];
  for (const entry of content as Array<Record<string, unknown>>) {
    if (entry["type"] !== "diff") continue;
    const path = typeof entry["path"] === "string" ? entry["path"] : "file";
    const oldText = typeof entry["oldText"] === "string" ? entry["oldText"] : "";
    const newText = typeof entry["newText"] === "string" ? entry["newText"] : "";
    const body = [
      ...(oldText ? oldText.split("\n").map((l) => `-${l}`) : []),
      ...(newText ? newText.split("\n").map((l) => `+${l}`) : []),
    ].join("\n");
    diffs.push({ path, body });
  }
  return diffs;
}

/** A filesystem-safe name for the downloaded file. */
export function exportFilename(record: SessionRecord): string {
  const base = (record.title ?? "conversation")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const date = new Date(record.createdAt).toISOString().slice(0, 10);
  return `${date}-${base || "conversation"}.md`;
}
