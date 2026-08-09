#!/usr/bin/env bash
#
# Stop hook: verify C# IntelliSense still works before a turn is allowed to end.
#
# Gated on `git status` so it costs nothing on turns that changed nothing —
# asking a question, reading code, planning. When the working tree under
# editor/ IS dirty, the full end-to-end check runs (~8s) regardless of WHICH
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
command -v node >/dev/null 2>&1 || exit 0

changes="$(git -C "$repo_root" status --porcelain -- editor arcane-extension 2>/dev/null)"
[ -n "$changes" ] || exit 0

output="$(cd "$editor_dir" && node scripts/verify-csharp-intellisense.mjs 2>&1)"
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
if printf '%s' "$output" | grep -q 'SKIPPED'; then
  printf '%s\n' '{"systemMessage":"C# IntelliSense check SKIPPED (prerequisites missing) — it did not run and is not evidence IntelliSense works."}'
fi

exit 0
