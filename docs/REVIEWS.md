# Review log

One row per review, newest first. The point is the **range**: the next review
starts where the last one ended, so nothing is silently skipped and nothing is
re-read for free.

Record a review whether or not it found anything — "reviewed, nothing found" is
a useful fact, and an absent row is indistinguishable from a skipped review.

| Date | Reviewed through | Range since previous | Findings | Notes |
|---|---|---|---|---|
| 2026-09-14 | `bdc58c9` | `dbf75c0..bdc58c9` (1 commit) | 0 new; **the 7 remaining findings closed** | The rooms and scheduler batch from both earlier reviews, fixed together because they share the code: a room turn is capped (`withTimeout`, then cancel) and the view says when a participant is waiting on a permission answer; a released hold and a cut-in now act on the running round instead of trying to start a second one; messages are quoted so a reply cannot speak as the user; a failed participant spawn closes the ones before it; the scheduler's tick no longer awaits each run and records an overlap once. Fixing the cap turned up that `cancel()` never answered pending permission requests, which the spec says it MUST — that is fixed and noted in PROTOCOL.md. Windows reaping is not fixed: it says it is unsupported instead of silently doing nothing, and is recorded as debt. Each fix has its test and its gotcha. |
| 2026-09-14 | `dbf75c0` | `dedc8bc..dbf75c0` (3 commits) | 0 new; **14 of the 21 open findings fixed** | A fix pass over both earlier reviews rather than a fresh read — the range is only PR #27 (the Origin allowlist and `strictPort`), read while closing the `Host` hole beside it. Fixed, each with a test and a gotcha: `prompt()` resolving early (which broke scheduled runs with an opening message and corrupted room turns), no `turn_end` on a killed or closed turn, the missing `Host` check, auto-approve granting `allow_always`, the static-file read crash, `updateProvider` erasing dropped entries, `persistMeta` un-archiving, `outputByteLimit`, the export path, the schedule status literal, the empty `catch` in rooms, `oldText` absent-vs-empty, and `setAutoApprove` landing after the opening turn. Still open, under *Bugs to fix* in [PLAN.md](PLAN.md): the rooms batch (turn cap, hold/cut-in, message fencing, participant leak), the scheduler's per-minute `skipped` rows and serial tick, and Windows reaping. |
| 2026-09-14 | `dedc8bc` | `cd32fd1..dedc8bc` (33 commits) | 14 bugs — one serious (a scheduled run with an opening message records *ok* having done nothing), one widening a pre-existing hole (no `Host` check) | Two passes by sub-agents over the rooms, schedules, start options, command pickers, Changes pane and games: one adversarial, one against PLAN.md and the definition of done. All seven bugs from the first review confirmed still open (line refs drifted). Everything recorded under *Bugs to fix* and *Smaller, still open* in [PLAN.md](PLAN.md); nothing fixed here. Checked and clean: SQL parameterisation in the new tables, `DiffView`'s escaping, localStorage handling, body validation on the new routes, process lifetime for runs and participants, Origin coverage of the new routes. |
| 2026-09-10 | `cd32fd1` | `f7274a5..cd32fd1` (82 commits) | 10 — one serious, two breaking an invariant | Security-focused pass over `packages/`. Three fixed here; the rest are recorded under *Bugs to fix* in [PLAN.md](PLAN.md) rather than left in a review comment. Checked and clean: static-file path traversal, the export filename, FTS5 quoting, markdown sanitisation. |

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
