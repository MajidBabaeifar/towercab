// A dialog (UI-261's merge confirm, UI-262, UI-265): Escape closes it, Tab stays inside it, and the focus
// goes back to where it was.

import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

export function Modal({
  label,
  onClose,
  children,
  focus,
  class: cls,
}: {
  label: string;
  onClose(): void;
  children: ComponentChildren;
  /** A selector for what takes the focus first; the dialog itself when none. */
  focus?: string;
  class?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // A layout effect: the dialog has the focus and its keys the moment it is on screen.
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focus ? box.current?.querySelector<HTMLElement>(focus) : null;
    (first ?? box.current)?.focus();
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      } else if (e.key === "Tab" && box.current) {
        const all = [
          ...box.current.querySelectorAll<HTMLElement>(
            "button, a[href], input, select, textarea, [tabindex='0']",
          ),
        ].filter((x) => !x.hasAttribute("disabled"));
        if (!all.length) return;
        const at = all.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : at === all.length - 1 ? 0 : at + 1;
        e.preventDefault();
        all[next]?.focus();
      }
    };
    addEventListener("keydown", on, true);
    return () => {
      removeEventListener("keydown", on, true);
      before?.focus?.();
    };
  }, [focus]);
  return (
    <div class="modal-back">
      <div
        class={`modal${cls ? ` ${cls}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={box}
      >
        {children}
      </div>
    </div>
  );
}
