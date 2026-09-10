/** Longest a derived title may be before it is cut short. */
const MAX_LENGTH = 60;

/**
 * Openers that say nothing about the conversation.
 *
 * Anchored and matched once, so "please" survives in the middle of a sentence
 * and only a leading pleasantry is dropped.
 */
const FILLER =
  /^(?:hey|hi|hello|ok(?:ay)?|so|right|(?:i )?(?:just )?(?:want|need|would like) (?:you )?to|can you(?: please)?|could you(?: please)?|would you(?: please)?|please(?: can you)?|help me(?: to)?|let'?s|lets|i'?d like (?:you )?to)\b[\s,:-]*/i;

/**
 * Names a conversation from its first message, when the agent has not named it
 * itself.
 *
 * The agent's own title is always better and always wins — this is the fallback
 * for agents that send none. It is deliberately not a summarisation call: we
 * are an ACP client with no model of our own, so summarising would mean either
 * spawning a second agent to name a chat or spending the user's own context on
 * it. Trimming the noise off the first line gets most of the way for nothing.
 *
 * Returns null when there is nothing usable, so the caller can leave the title
 * unset rather than storing an empty string.
 */
export function titleFromMessage(text: string): string | null {
  const line = firstProseLine(text);
  if (!line) return null;

  const trimmed = stripFiller(line);
  if (!trimmed) return null;

  const capped = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return capped.length > MAX_LENGTH ? `${capped.slice(0, MAX_LENGTH - 1).trimEnd()}…` : capped;
}

/**
 * The first line with words in it, ignoring markdown scaffolding.
 *
 * A message often opens with a heading, a bullet or a fenced block; the line
 * that says what the conversation is about is the first one left after those
 * are discarded.
 */
function firstProseLine(text: string): string {
  let inFence = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;

    const cleaned = line
      .replace(/^[>\s]*/, "") // blockquote markers
      .replace(/^#{1,6}\s+/, "") // heading
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "") // list bullet
      .replace(/^\[[ xX]\]\s*/, "") // task checkbox
      .replace(/[*_`]/g, "") // inline emphasis and code
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned) return cleaned;
  }
  return "";
}

/** Drops a leading pleasantry, but never the whole message. */
function stripFiller(line: string): string {
  const stripped = line.replace(FILLER, "").trim();
  return stripped || line;
}
