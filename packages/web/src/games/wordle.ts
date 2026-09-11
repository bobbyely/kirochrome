export type Mark = "hit" | "near" | "miss";

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

/**
 * Score a guess against the answer.
 *
 * Two passes, because a letter can only be "near" if the answer still has an
 * unmatched copy of it: guessing "eerie" against "steel" must not light every
 * e. Hits are claimed first, then nears consume what is left.
 */
export function score(guess: string, answer: string): Mark[] {
  const marks: Mark[] = Array.from(guess, () => "miss");
  const unmatched: (string | null)[] = [...answer];

  for (let i = 0; i < guess.length; i++) {
    if (guess.charAt(i) !== answer.charAt(i)) continue;
    marks[i] = "hit";
    unmatched[i] = null;
  }
  for (let i = 0; i < guess.length; i++) {
    if (marks[i] === "hit") continue;
    const j = unmatched.indexOf(guess.charAt(i));
    if (j < 0) continue;
    marks[i] = "near";
    unmatched[j] = null;
  }
  return marks;
}

/** The best mark seen for each letter, for the on-screen keyboard. */
export function keyboardMarks(guesses: readonly string[], answer: string): Map<string, Mark> {
  const rank: Record<Mark, number> = { miss: 0, near: 1, hit: 2 };
  const best = new Map<string, Mark>();
  for (const guess of guesses) {
    score(guess, answer).forEach((mark, i) => {
      const letter = guess.charAt(i);
      const prev = best.get(letter);
      if (!prev || rank[mark] > rank[prev]) best.set(letter, mark);
    });
  }
  return best;
}
