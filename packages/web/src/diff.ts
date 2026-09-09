export type DiffLine = { kind: "add" | "del" | "ctx"; text: string };

/** Beyond this the quadratic LCS is not worth it; we show the new text instead. */
const MAX_LINES = 1500;

/**
 * A line-level diff, via longest common subsequence.
 *
 * Hand-rolled rather than pulled in: agent diffs are small, and this avoids a
 * dependency for ~40 lines of well-understood code.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] | null {
  // "".split("\n") is [""], not [] — without this a newly created file renders
  // a phantom deleted blank line.
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      lines.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) lines.push({ kind: "del", text: a[i++]! });
  while (j < b.length) lines.push({ kind: "add", text: b[j++]! });
  return lines;
}

/** Collapses long runs of unchanged lines, keeping `context` either side. */
export function collapseContext(lines: DiffLine[], context = 3): Array<DiffLine | { kind: "gap"; count: number }> {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "ctx") return;
    for (let k = index - context; k <= index + context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  const out: Array<DiffLine | { kind: "gap"; count: number }> = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped > 0) {
        out.push({ kind: "gap", count: skipped });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: "gap", count: skipped });
  return out;
}

export const countChanges = (lines: DiffLine[]) => ({
  added: lines.filter((l) => l.kind === "add").length,
  removed: lines.filter((l) => l.kind === "del").length,
});
