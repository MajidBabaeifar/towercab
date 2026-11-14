// Keyboard helpers (UI-261, UI-262, UI-265): which key presses a shortcut may take, and the events that open
// the global dialogs.

const SHORTCUTS = "towercab:shortcuts";
const PALETTE = "towercab:palette";
const NEW_INTENT = "towercab:new-intent";

export const openShortcuts = (): void => void dispatchEvent(new Event(SHORTCUTS));
export const openPalette = (): void => void dispatchEvent(new Event(PALETTE));
export const openNewIntent = (): void => void dispatchEvent(new Event(NEW_INTENT));
export const NEW_INTENT_EVENT = NEW_INTENT;
export const SHORTCUTS_EVENT = SHORTCUTS;
export const PALETTE_EVENT = PALETTE;

/**
 * UI-261: a single-key shortcut does nothing while the focus is in a field, a select or a dialog, and
 * ignores combinations with Ctrl, Cmd or Alt.
 */
export function ignored(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return true;
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  return document.querySelector("[role=dialog]") !== null;
}

/** Is the focus on something that acts on Enter by itself (a button, a link, a summary)? */
export function actsOnEnter(e: KeyboardEvent): boolean {
  const t = e.target instanceof Element ? e.target : null;
  return t?.closest("button, a[href], summary") != null;
}
