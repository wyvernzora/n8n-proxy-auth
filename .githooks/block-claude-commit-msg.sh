#!/usr/bin/env bash
set -euo pipefail

msg_file="${1:?missing commit message file}"

# Case-insensitive. Matches "claude" as a standalone-ish token:
#   Claude
#   claude
#   CLAUDE
#   Claude Code
#   claude-code
#   claude_code
#   Co-authored-by: Claude <...>
if grep -Eiq '(^|[^[:alnum:]])claude([^[:alnum:]]|$)' "$msg_file"; then
  cat >&2 <<'MSG'
Commit rejected: commit message must not mention Claude.

Remove references like:
  - Claude
  - Claude Code
  - Generated with Claude
  - Co-authored-by: Claude <...>
MSG
  exit 1
fi
