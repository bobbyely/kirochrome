# Local steering

Your file. [AGENTS.md](AGENTS.md) is the repo's rules; this is yours on top of
them — style preferences, how you like to be asked things, shortcuts, anything
specific to how *you* work on this codebase.

It ships blank on purpose. Write whatever is useful; delete this preamble if it
is in the way.

**Precedence:** where this file and AGENTS.md disagree, **this file wins** — for
conventions, working style, commit habits, and how much explanation you want.

**Except the invariants.** Those are correctness and security properties, not
preferences: append-only events, `127.0.0.1` only, every process killable,
typed errors. Changing one is a design decision and belongs in AGENTS.md where
the change is visible in the repo's history — not in a personal file where the
next reader will not think to look.

**It is committed**, so it travels with the repo and any agent reading the
project sees it. If you would rather keep yours private, exclude it locally
without touching `.gitignore`:

```bash
echo "AGENTS.local.md" >> .git/info/exclude
git rm --cached AGENTS.local.md
```

---
