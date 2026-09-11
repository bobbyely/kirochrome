/**
 * True when `word` can be spelled from `letters`, each letter used at most as
 * many times as it appears.
 */
export function canSpell(word: string, letters: string): boolean {
  const left = [...letters];
  for (const ch of word) {
    const i = left.indexOf(ch);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

/** A random reordering that is never the input order, for two or more letters. */
export function shuffle(letters: string): string {
  if (letters.length < 2) return letters;
  let out = letters;
  do {
    const chars = [...out];
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      chars.splice(i, 0, ...chars.splice(j, 1));
    }
    out = chars.join("");
  } while (out === letters);
  return out;
}

/** Longer words are worth more; the full puzzle word is a bonus on top. */
export function points(word: string, puzzle: string): number {
  const base = word.length - 3;
  return word === puzzle ? base * 2 : base;
}
