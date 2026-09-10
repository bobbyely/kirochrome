# Review log

One row per review, newest first. The point is the **range**: the next review
starts where the last one ended, so nothing is silently skipped and nothing is
re-read for free.

Record a review whether or not it found anything — "reviewed, nothing found" is
a useful fact, and an absent row is indistinguishable from a skipped review.

| Date | Reviewed through | Range since previous | Findings | Notes |
|---|---|---|---|---|
| — | — | — | — | No review yet. First one starts at the root commit. |

## How to record one

After reviewing, add a row and commit it with the fixes:

```bash
git log -1 --format='%h  %ad' --date=short          # what you reviewed through
git log --oneline <previous>..HEAD | wc -l          # how many commits the range covered
```

- **Reviewed through** — the commit the review ended at, short hash.
- **Range since previous** — `<previous>..<this>`, so the next reviewer can
  replay exactly what was covered.
- **Findings** — a count, and a word on severity. Zero is a valid entry.
- **Notes** — anything deferred, and why. A deferred finding with no note is
  just a forgotten one.

## What to look for

See the *Periodic code review* section in [PLAN.md](PLAN.md). It lists the four
failure shapes this codebase has actually produced, which is more useful than a
generic checklist.

## When a review finds something

Fix it, add the test, and add the gotcha to [GOTCHAS.md](GOTCHAS.md). Every
entry in there exists because something was once wrong; a fix without one
invites the same bug from the next person who does not know.
