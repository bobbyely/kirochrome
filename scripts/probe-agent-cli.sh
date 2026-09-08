#!/usr/bin/env bash
# Probe a CLI agent to learn how it can be driven programmatically.
#
# Run this on the machine that HAS the CLI (e.g. your work machine):
#
#     ./scripts/probe-agent-cli.sh kiro
#
# It writes probe-<cmd>-<timestamp>.txt in the current directory.
#
# It only reads help text and sends one trivial prompt. It does NOT enable
# tool execution or auto-approval. Even so: READ THE OUTPUT FILE BEFORE
# SHARING IT — help text can contain internal URLs, account ids or profile
# names.

set -uo pipefail   # deliberately no -e: probes are expected to fail

CMD="${1:-kiro}"
OUT="probe-${CMD}-$(date +%Y%m%d-%H%M%S).txt"

if ! command -v "$CMD" >/dev/null 2>&1; then
  echo "'$CMD' not found on PATH." >&2
  echo "Try: kiro, kiro-cli, q" >&2
  exit 1
fi

section() { printf '\n\n===== %s =====\n' "$1" >>"$OUT"; }

# Run a command, capturing stdout+stderr and the exit code, with a timeout so
# an interactive prompt can't hang the probe.
try() {
  section "$*"
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 "$@" </dev/null >>"$OUT" 2>&1
  else
    "$@" </dev/null >>"$OUT" 2>&1     # macOS without coreutils
  fi
  printf '\n[exit code: %s]\n' "$?" >>"$OUT"
}

{
  echo "probe of '$CMD'"
  echo "date:     $(date)"
  echo "uname:    $(uname -a)"
  echo "resolved: $(command -v "$CMD")"
} >"$OUT"

# --- 1. What subcommands and flags exist? ---
try "$CMD" --version
try "$CMD" --help
try "$CMD" chat --help
try "$CMD" help

# --- 2. Is there a non-interactive / headless mode? ---
# One of these should work; the rest will error, which is itself informative.
try "$CMD" chat --no-interactive "reply with exactly: PROBE_OK"
try "$CMD" chat --non-interactive "reply with exactly: PROBE_OK"
try "$CMD" chat "reply with exactly: PROBE_OK"
try "$CMD" "reply with exactly: PROBE_OK"

# --- 3. Is there structured output we can parse? ---
try "$CMD" chat --output-format json "reply with exactly: PROBE_OK"
try "$CMD" chat --format json "reply with exactly: PROBE_OK"
try "$CMD" chat --json "reply with exactly: PROBE_OK"

# --- 4. Does it accept a prompt on stdin? ---
section "stdin: echo prompt | $CMD chat"
if command -v timeout >/dev/null 2>&1; then
  echo "reply with exactly: PROBE_OK" | timeout 30 "$CMD" chat >>"$OUT" 2>&1
else
  echo "reply with exactly: PROBE_OK" | "$CMD" chat >>"$OUT" 2>&1
fi
printf '\n[exit code: %s]\n' "$?" >>"$OUT"

# --- 5. Does it emit ANSI colour when not attached to a terminal? ---
# Escape bytes in the file above answer this; count them explicitly.
section "ANSI escape count in this file"
grep -c $'\033' "$OUT" >>"$OUT" 2>&1

echo
echo "Wrote $OUT"
echo "Review it for anything work-sensitive, then share it."
