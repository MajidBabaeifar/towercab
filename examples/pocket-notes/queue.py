"""Queue this mission once; do not start an agent."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from factory.core import Store


if __name__ == "__main__":
    example = Path(__file__).resolve().parent
    store = Store(ROOT / ".factory-pocket-notes")
    # Dedicated queue: rerunning setup must not duplicate the mission.
    missions = store.rows()
    if missions:
        print(f"Already queued: {missions[0]['id']} ({missions[0]['status']})")
    else:
        mid = store.add(
            "Pocket Notes — local notebook CLI",
            (example / "brief.md").read_text(), None,
            [sys.executable, str(example / "verify.py")],
            provider="codex", reviewer="codex", max_repairs=3,
        )
        print(f"Queued {mid}; no agents started.")
