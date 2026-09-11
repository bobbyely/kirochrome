import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { canSpell, points, shuffle } from "./anagram.js";
import { keyboardMarks, MAX_GUESSES, score, WORD_LENGTH, type Mark } from "./wordle.js";

type Words = typeof import("./words.js");

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  // The lists are generated and never empty; this only guards the type.
  if (item === undefined) throw new Error("pick: empty list");
  return item;
}

/**
 * Something to do while the agent works: a small panel in the corner of the window
 * with two word games. Pure UI state — nothing here is conversation state,
 * so nothing here is persisted.
 *
 * Both games stay mounted, and the panel stays mounted while closed, so a
 * game in progress survives switching tabs or hiding the panel.
 *
 * The word list is loaded on first open rather than bundled with the app,
 * because it is bigger than everything else on this page put together and
 * most sessions never open this.
 */
export function GamesPanel({
  open,
  awaitingInput,
  onClose,
}: {
  open: boolean;
  awaitingInput: boolean;
  onClose: () => void;
}) {
  const [words, setWords] = useState<Words | null>(null);
  const [game, setGame] = useState<"wordle" | "anagram">("wordle");
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || words) return;
    let cancelled = false;
    void import("./words.js").then((m) => {
      if (!cancelled) setWords(m);
    });
    return () => {
      cancelled = true;
    };
  }, [open, words]);

  // Focus the visible game so keystrokes land without a click.
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>("div:not([hidden]) > .game")?.focus();
  }, [open, words, game]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Stop the global Escape (which leaves the chat) from firing too.
    e.stopPropagation();
    onClose();
  };

  return (
    <div className="games" ref={panel} tabIndex={-1} onKeyDown={onKeyDown} role="dialog" aria-label="Games" hidden={!open}>
      <div className="games-head">
        <button className={game === "wordle" ? "games-tab active" : "games-tab"} onClick={() => setGame("wordle")}>
          Wordle
        </button>
        <button className={game === "anagram" ? "games-tab active" : "games-tab"} onClick={() => setGame("anagram")}>
          Anagram
        </button>
        <span className="games-spacer" />
        {awaitingInput && <span className="games-nudge">Agent needs you</span>}
        <button className="games-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          ×
        </button>
      </div>
      {!words && <p className="muted">Loading words…</p>}
      {words && (
        <>
          <div hidden={game !== "wordle"}>
            <Wordle words={words} />
          </div>
          <div hidden={game !== "anagram"}>
            <Anagram words={words} />
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Wordle({ words }: { words: Words }) {
  const [answer, setAnswer] = useState(() => pick(words.ANSWERS));
  const [guesses, setGuesses] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const won = guesses.at(-1) === answer;
  const over = won || guesses.length === MAX_GUESSES;

  const reset = () => {
    setAnswer(pick(words.ANSWERS));
    setGuesses([]);
    setDraft("");
    setNote(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (over) {
      if (e.key === "Enter") reset();
      return;
    }
    if (e.key === "Backspace") {
      setDraft((d) => d.slice(0, -1));
      setNote(null);
    } else if (e.key === "Enter") {
      if (draft.length < WORD_LENGTH) return setNote("Too short");
      if (!words.FIVE.has(draft)) return setNote("Not in word list");
      setGuesses((g) => [...g, draft]);
      setDraft("");
      setNote(null);
    } else if (/^[a-z]$/i.test(e.key)) {
      setDraft((d) => (d + e.key.toLowerCase()).slice(0, WORD_LENGTH));
      setNote(null);
    } else {
      return;
    }
    e.preventDefault();
  };

  const rows = Array.from({ length: MAX_GUESSES }, (_, i) => {
    const guess = guesses[i];
    if (guess) return { letters: [...guess], marks: score(guess, answer) };
    const letters = i === guesses.length ? [...draft.padEnd(WORD_LENGTH)] : [..." ".repeat(WORD_LENGTH)];
    return { letters, marks: null };
  });
  const keys = keyboardMarks(guesses, answer);

  return (
    <div className="game" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="wordle-grid">
        {rows.map((row, r) => (
          <div className="wordle-row" key={r}>
            {row.letters.map((ch, c) => (
              <span className={`tile ${row.marks?.[c] ?? (ch.trim() ? "typed" : "")}`} key={c}>
                {ch}
              </span>
            ))}
          </div>
        ))}
      </div>
      <Keyboard marks={keys} />
      <p className="game-note">
        {won && `Got it in ${guesses.length}. Enter for another.`}
        {!won && over && `It was "${answer}". Enter for another.`}
        {!over && (note ?? "Type a five-letter word, Enter to guess.")}
      </p>
      <div className="game-actions">
        <button onClick={reset}>New game</button>
      </div>
    </div>
  );
}

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function Keyboard({ marks }: { marks: Map<string, Mark> }) {
  return (
    <div className="keys" aria-hidden="true">
      {KEY_ROWS.map((row) => (
        <div className="keys-row" key={row}>
          {[...row].map((k) => (
            <span className={`key ${marks.get(k) ?? ""}`} key={k}>
              {k}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Anagram({ words }: { words: Words }) {
  const [[puzzle, valid], setPuzzle] = useState(() => pick(words.PUZZLES));
  const [letters, setLetters] = useState(() => shuffle(puzzle));
  const [found, setFound] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const solved = found.includes(puzzle);
  const total = found.reduce((sum, w) => sum + points(w, puzzle), 0);
  // Every word there is to find: the puzzle word plus the common words in it.
  const all = [puzzle, ...valid];
  const done = solved && found.length === all.length;
  const missed = revealed ? all.filter((w) => !found.includes(w)) : [];

  const next = () => {
    const p = pick(words.PUZZLES);
    setPuzzle(p);
    setLetters(shuffle(p[0]));
    setFound([]);
    setDraft("");
    setNote(null);
    setRevealed(false);
  };

  const submit = () => {
    if (draft.length < 4) return setNote("Four letters or more");
    if (found.includes(draft)) return setNote("Already found");
    if (draft !== puzzle && !valid.includes(draft)) return setNote("Not in word list");
    setFound((f) => [draft, ...f]);
    setDraft("");
    setNote(draft === puzzle ? "That's the big one" : `+${points(draft, puzzle)}`);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Backspace") {
      setDraft((d) => d.slice(0, -1));
      setNote(null);
    } else if (e.key === "Enter") {
      submit();
    } else if (e.key === " ") {
      setLetters((l) => shuffle(l));
    } else if (/^[a-z]$/i.test(e.key)) {
      const nextDraft = draft + e.key.toLowerCase();
      if (canSpell(nextDraft, puzzle)) setDraft(nextDraft);
      setNote(null);
    } else {
      return;
    }
    e.preventDefault();
  };

  // Letters still on the rack: the draft's letters are lifted off it.
  const rack = [...letters];
  const used = new Set<number>();
  for (const ch of draft) {
    const i = rack.findIndex((r, idx) => r === ch && !used.has(idx));
    if (i >= 0) used.add(i);
  }

  return (
    <div className="game" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="rack">
        {rack.map((ch, i) => (
          <span className={used.has(i) ? "tile lifted" : "tile typed"} key={i}>
            {ch}
          </span>
        ))}
      </div>
      <div className="draft">
        {draft || <span className="muted">…</span>}
        <span className="game-score">
          {found.length}/{all.length} · {total} pts
        </span>
      </div>
      <p className="game-note">
        {done && "All of them. "}
        {revealed && !solved && `It was "${puzzle}". `}
        {note ?? "Enter to submit, Space to shuffle."}
      </p>
      <div className="found">
        {found.map((w) => (
          <span className={w === puzzle ? "found-word hit" : "found-word"} key={w}>
            {w}
          </span>
        ))}
        {missed.map((w) => (
          <span className="found-word missed" key={w}>
            {w}
          </span>
        ))}
      </div>
      <div className="game-actions">
        {!done && !revealed && <button onClick={() => setRevealed(true)}>Give up</button>}
        <button onClick={next}>New game</button>
      </div>
    </div>
  );
}
