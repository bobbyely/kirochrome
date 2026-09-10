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
  /** Set while the last event was a replayed user chunk, so the next extends it. */
  let afterUserChunk = false;

  for (const event of events) {
    const continuing = afterUserChunk;
    afterUserChunk = isUserChunk(event);
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

      case "adopted":
        lines.push(
          `> Adopted from ${event.providerName}. Everything above was replayed by the agent ` +
            `rather than logged by KiroChrome.`,
          "",
        );
        break;

      // An adopted conversation's history arrives as ACP updates, so what the
      // user said is a chunk rather than a `user_message`. Without this the
      // export shows only the agent's half of a conversation we took over.
      case "agent_update": {
        const update = event.update as { sessionUpdate?: string; content?: { text?: string } };
        if (update.sessionUpdate !== "user_message_chunk") break;
        const text = update.content?.text ?? "";
        if (!text) break;
        // Chunks split mid-sentence, so a continuation extends the paragraph
        // already written rather than starting a new one.
        const body = lines.length - 2;
        if (continuing && body >= 0) lines[body] += text;
        else lines.push(`## You`, "", text, "");
        break;
      }

      // turn markers and state updates carry no transcript content
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** A replayed user message, which arrives as an ACP update rather than an event of ours. */
function isUserChunk(event: KcEvent): boolean {
  if (event.type !== "agent_update") return false;
  return (event.update as { sessionUpdate?: string }).sessionUpdate === "user_message_chunk";
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
