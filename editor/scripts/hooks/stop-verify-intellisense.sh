#!/usr/bin/env bash
#
# Stop hook: verify C# IntelliSense still works before a turn is allowed to end.
#
# Gated on `git status` so it costs nothing on turns that changed nothing —
# asking a question, reading code, planning. When the working tree under
# editor/ IS dirty, the full end-to-end check runs (~30s) regardless of WHICH
# files changed, because the break this guards against was environmental: it
# was not introduced by any diff, so "the diff looks unrelated" is not evidence
# that IntelliSense survived.
#
# Exit 0 = turn proceeds. Exit 2 = blocking error, stderr is fed back to Claude.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)" || exit 0
editor_dir="$repo_root/editor"

# Never let hook plumbing wedge a session: any unexpected condition exits 0.
[ -d "$editor_dir" ] || exit 0
# The probe imports the editor's own `fileUri`/`lspDocumentUri` (that is the
# point of it — see the script header), so it runs under bun, not node.
if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' '{"systemMessage":"C# IntelliSense check SKIPPED (bun not on PATH) — it did not run and is not evidence IntelliSense works."}'
  exit 0
fi

changes="$(git -C "$repo_root" status --porcelain -- editor arcane-extension 2>/dev/null)"
[ -n "$changes" ] || exit 0

output="$(cd "$editor_dir" && bun run scripts/verify-csharp-intellisense.ts 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  {
    echo "C# IntelliSense verification FAILED."
    echo "Do not report this work as complete until it passes. Investigate before finishing."
    echo
    echo "$output"
  } >&2
  exit 2
fi

# A skip is not a pass. Surface it so "IntelliSense works" is never claimed on
# the strength of a check that never ran — the exact trap that hid this outage.
#
# Read the RESULT line, which is the script's output contract, rather than
# grepping the whole transcript: a run that passed everything can still mention
# SKIPPED in the middle (a section that could not run), and those two cases
# deserve different words.
result="$(printf '%s' "$output" | grep -E '^RESULT ' | tail -1)"
case "$result" in
  'RESULT SKIPPED'*)
    printf '%s\n' '{"systemMessage":"C# IntelliSense check SKIPPED (prerequisites missing) — it did not run and is not evidence IntelliSense works."}'
    ;;
  'RESULT PARTIAL'*)
    printf '%s\n' '{"systemMessage":"C# IntelliSense passed, but some sections did not run — see the SKIPPED note on the RESULT line. Those parts are unverified."}'
    ;;
esac

exit 0
