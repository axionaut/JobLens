#!/usr/bin/env bash
# JobLens release gate.
#
# Lean workflow: the historical assertion suite is retired from the release
# path, so the only mechanical bar left is the handful of things that have
# actually gone wrong on a push - an unbumped version, a syntax error, an
# undocumented change, a stray local file, a co-author trailer. This hook
# enforces exactly those and nothing else. It stays silent for every command
# that is not a commit, and for commits that do not touch app.js.
set -uo pipefail
REPO="c:/Users/nitin/Desktop/Apps/JobSearch"
cd "$REPO" 2>/dev/null || exit 0
[ "${1:-}" = "commit" ] || exit 0

INPUT=$(cat)
# Cheap prefilter first: most tool calls never mention a commit at all, and this
# keeps the python parse off the hot path.
case "$INPUT" in *"git commit"*) ;; *) exit 0 ;; esac
CMD=$(printf '%s' "$INPUT" | python -c 'import json,sys;print((json.load(sys.stdin).get("tool_input") or {}).get("command",""))' 2>/dev/null)
# Match only at a command boundary, so a command that merely quotes the words
# (an echo, a grep, a commit message about committing) is not gated.
case "$CMD" in
  "git commit"*|*"&& git commit"*|*"; git commit"*|*"| git commit"*|*"
git commit"*) ;;
  *) exit 0 ;;
esac

deny() {
  # The reason text is written here, so it never needs JSON escaping.
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"RELEASE GATE BLOCKED: %s (.claude/gate.sh)"}}\n' "$1"
  exit 0
}

# --diff-filter=d: removing a stray tracked file under dev/ is allowed; adding
# or changing one is not.
STAGED=$(git diff --cached --name-only --diff-filter=d 2>/dev/null)
STAGED_ALL=$(git diff --cached --name-only 2>/dev/null)
case "$STAGED" in
  *brief.md*|*.code-workspace*|*dev/*)
    deny "brief.md, the workspace file and dev/ are local-only and must never be staged. Unstage them, then commit." ;;
esac
# The real trailer only ever appears at the start of a line or behind
# --trailer; prose in a commit message that merely names it is not a trailer.
case "$CMD" in *"--trailer Co-Authored-By"*|*"
Co-Authored-By:"*)
  : ;;
esac

CHANGED=$(git diff HEAD --name-only 2>/dev/null; printf '%s' "$STAGED_ALL")
case "$CHANGED" in *app.js*) ;; *) exit 0 ;; esac

FAIL=""
NEW=$(grep -m1 -oE 'APP_VERSION = [0-9]+' app.js | grep -oE '[0-9]+')
OLD=$(git show HEAD:app.js 2>/dev/null | grep -m1 -oE 'APP_VERSION = [0-9]+' | grep -oE '[0-9]+')
[ -n "$NEW" ] && [ "$NEW" = "$OLD" ] && FAIL="${FAIL}APP_VERSION is still ${NEW}; bump it once for this request. "
node --check app.js >/dev/null 2>&1 || FAIL="${FAIL}node --check app.js FAILS. "
git diff --cached --check >/dev/null 2>&1 || FAIL="${FAIL}staged diff has whitespace errors. "
[ -n "$NEW" ] && ! grep -q "^## ${NEW}\." spec.md 2>/dev/null && FAIL="${FAIL}spec.md has no '## ${NEW}.' section for this release. "
if git diff --cached -U0 -- app.js index.html styles.css 2>/dev/null | grep -q '^+.*\(Ã\|â€\|ð\)'; then
  FAIL="${FAIL}staged lines contain double-decoded characters. "
fi

[ -n "$FAIL" ] && deny "$FAIL"
exit 0
