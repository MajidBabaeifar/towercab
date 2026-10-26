#!/usr/bin/env bash
# Link the /intent skill into ~/.claude/skills (INT-9) and towercab into ~/.local/bin.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skills="$HOME/.claude/skills"
mkdir -p "$skills" "$HOME/.local/bin"
ln -sfn "$here/skills/intent" "$skills/intent"
ln -sfn "$here/bin/towercab" "$HOME/.local/bin/towercab"
echo "Linked $skills/intent -> $here/skills/intent"
echo "Linked $HOME/.local/bin/towercab -> $here/bin/towercab"
