#!/usr/bin/env bash
# Link `towercab` into ~/.local/bin so it runs from any folder.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${XDG_BIN_HOME:-$HOME/.local/bin}"
chmod +x "$here/bin/towercab"
mkdir -p "$dest"
ln -sf "$here/bin/towercab" "$dest/towercab"
echo "Linked $dest/towercab -> $here/bin/towercab"
case ":$PATH:" in
  *":$dest:"*) ;;
  *) echo "Warning: $dest is not on PATH; add it to your shell profile." >&2 ;;
esac
