import type { KcEvent, ProviderRef } from "./events.js";

/**
 * What a new agent is told when a conversation moves to it.
 *
 * ACP has no session transfer, so this is prose: the transcript so far, with
 * the agent's words attributed to whichever provider said them and tool calls
 * reduced to what they did. Deterministic over the log, so the server builds
 * it and the browser can show the same text under the divider. No model of
 * our own summarises anything: if it does not fit, the oldest messages are
 * dropped whole and the text says how many.
 */

/** Characters, not tokens: roughly 15k tokens, well inside every agent's window. */
export const HANDOFF_BUDGET = 60_000;

export interface Handoff {
  text: string;
  /** Messages in the transcript, before any were dropped for the budget. */
  messages: number;
  omitted: number;
}

/**
 * The transcript up to and including `throughSeq`, addressed to the agent
 * that takes over. `from` is the provider being left; the agent's words are
 * attributed by walking forward from the first provider through every
 * switch in the log.
 */
export function handoffText(
  events: ReadonlyArray<KcEvent>,
  throughSeq: number,
  from: ProviderRef,
  cwd: string,
  budget = HANDOFF_BUDGET,
): Handoff {
  const included = events.filter((e) => e.seq <= throughSeq);
  const speakers = attribution(included, firstProvider(included) ?? from.name);
  const messages = transcript(included, speakers);

  const preamble = [
    `You are continuing a conversation that began with another assistant, ${from.name}. The person you are talking to has switched to you part-way through.`,
    `Below is the transcript so far. Any files it mentions editing are already on disk in ${cwd}; read them if you need their current state rather than trusting the transcript.`,
    `Continue from where it left off. Do not repeat or summarise the transcript unless asked. The message after the transcript is the person's next one.`,
    "",
    "--- transcript ---",
  ].join("\n");
  const close = "--- end of transcript ---";

  const notice = (n: number) => `[Earlier part of the conversation omitted to fit: ${n} message${n === 1 ? "" : "s"}.]`;
  // Room for the notice is set aside from the start, so dropping messages
  // never makes the text longer than the budget it was dropped to meet.
  let room = budget - preamble.length - close.length - 2 - (notice(messages.length).length + 2);
  const kept: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.length + 2 > room) break;
    kept.unshift(m);
    room -= m.length + 2;
  }
  const omitted = messages.length - kept.length;
  if (omitted > 0) kept.unshift(notice(omitted));

  return { text: [preamble, ...kept, close].join("\n\n"), messages: messages.length, omitted };
}

/** The message a person types after a switch, with the handoff in front of it. */
export function withHandoff(handoff: Handoff, text: string): string {
  return `${handoff.text}\n\nThe person now says:\n\n${text}`;
}

/** The provider the conversation started on: the `from` of its first switch, if it has had one. */
function firstProvider(events: ReadonlyArray<KcEvent>): string | null {
  for (const event of events) if (event.type === "provider_switched") return event.from.name;
  return null;
}

/** The provider whose words each `agent_text` is, by walking the switches. */
function attribution(events: ReadonlyArray<KcEvent>, initial: string): Map<number, string> {
  const names = new Map<number, string>();
  let current = initial;
  for (const event of events) {
    if (event.type === "provider_switched") current = event.to.name;
    if (event.type === "agent_text") names.set(event.seq, current);
  }
  return names;
}

function transcript(events: ReadonlyArray<KcEvent>, speakers: Map<number, string>): string[] {
  const out: string[] = [];
  const titles = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case "user_message":
        out.push(`Person:\n${event.text}`);
        break;
      case "agent_text":
        out.push(`${speakers.get(event.seq) ?? "Assistant"}:\n${event.text}`);
        break;
      case "tool_call":
        titles.set(event.toolCallId, event.title);
        break;
      case "tool_call_update": {
        // Only the edits are worth carrying: a later agent can re-read a file,
        // but it cannot see that the previous one changed it.
        for (const edit of edits(event.raw)) out.push(`[${titles.get(event.toolCallId) ?? "edit"}: ${edit}]`);
        break;
      }
      case "provider_switched":
        out.push(`[The conversation moved from ${event.from.name} to ${event.to.name} here.]`);
        break;
      case "adopted":
        out.push(`[Everything above was said in ${event.providerName}'s own CLI before KiroChrome took the conversation over.]`);
        break;
      default:
        break; // usage, permissions, terminals, errors: bookkeeping, not conversation
    }
  }
  return out;
}

/** "src/a.ts (+12 −3)" per diff a tool update carries. */
function edits(raw: unknown): string[] {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const entry of content as Array<Record<string, unknown>>) {
    if (entry["type"] !== "diff") continue;
    const path = typeof entry["path"] === "string" ? entry["path"] : "a file";
    const before = typeof entry["oldText"] === "string" ? entry["oldText"] : "";
    const after = typeof entry["newText"] === "string" ? entry["newText"] : "";
    const added = after ? after.split("\n").length : 0;
    const removed = before ? before.split("\n").length : 0;
    out.push(`${path} (+${added} −${removed})`);
  }
  return out;
}
