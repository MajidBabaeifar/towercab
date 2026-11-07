// UI-262: `?` lists every shortcut.

import { useEffect, useState } from "preact/hooks";
import { ignored, SHORTCUTS_EVENT } from "./keys.ts";
import { Modal } from "./Modal.tsx";

const KEYS: [string, string][] = [
  ["j / k", "Next or previous item in the Inbox"],
  ["Enter", "Open the selected item (it never acts by itself)"],
  ["Esc", "Back to the list"],
  ["m", "Merge: asks first, only on an item with a merge"],
  ["r", "Answer or reply on the selected item"],
  ["o", "Open the pull request in a new tab"],
  ["s", "Snooze the selected item"],
  ["/", "Filter the list"],
  ["?", "Show this list"],
  ["Cmd-K or Ctrl-K", "Search intents, repos and pull requests, or run a command"],
];

export function Shortcuts() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      if (e.key === "?" && !ignored(e)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    addEventListener(SHORTCUTS_EVENT, show);
    addEventListener("keydown", key);
    return () => {
      removeEventListener(SHORTCUTS_EVENT, show);
      removeEventListener("keydown", key);
    };
  }, []);
  if (!open) return null;
  return (
    <Modal label="Keyboard shortcuts" onClose={() => setOpen(false)} focus=".modal-close">
      <header class="modal-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" class="btn ghost modal-close" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>
      <dl class="shortcuts">
        {KEYS.map(([k, what]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
