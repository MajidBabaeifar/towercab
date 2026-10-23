#!/usr/bin/env bash
# Link the /intent skill into ~/.claude/skills (INT-9).
# The binary is separate: cargo install --path . --locked (LOOP-1).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skills="$HOME/.claude/skills"
mkdir -p "$skills"
ln -sfn "$here/skills/intent" "$skills/intent"
echo "Linked $skills/intent -> $here/skills/intent"
