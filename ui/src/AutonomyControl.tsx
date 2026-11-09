// UI-257, UI-258: the one control for an intent's autonomy, a0 to a5. Lowering is one click; raising asks
// first, naming the level and what it lets Towercab do without asking.

import { useRef, useState } from "preact/hooks";
import type { ActionReply, AutonomyView } from "../../src/ui/view.ts";
import { setAutonomy } from "./api.ts";

const LEVELS = [0, 1, 2, 3, 4, 5];

/** The choice's tooltip; the highest one says why a5 is missing for an intent that isn't the owner's (UI-206). */
function levelTitle(view: AutonomyView, n: number): string {
  const note = `a${n}: ${view.notes[n] ?? ""}`;
  return n === view.max && view.max < 5 ? `${note} (a5 is only for your own intents)` : note;
}

/** A click inside a row's link must not follow the link. */
const still = (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
};

export function AutonomyControl({
  intent,
  view,
  readOnly,
  compact = false,
}: {
  intent: string;
  view: AutonomyView;
  readOnly: boolean;
  /** On a card or row: the confirm sits under the control and the cap note is short. */
  compact?: boolean;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const group = useRef<HTMLSpanElement>(null);
  const off = readOnly || view.locked || busy;

  const save = async (n: number) => {
    setBusy(true);
    const r = await setAutonomy(intent, n);
    setBusy(false);
    setPending(null);
    setResult(r);
  };
  const choose = (n: number) => {
    if (off || n === view.a) return;
    setResult(null);
    if (n > view.a) setPending(n);
    else void save(n);
  };
  const move = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const all = [...(group.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = all[(at + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    next?.focus();
    e.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click here must not follow the row's link
    <span
      class="autonomy"
      onClick={still}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") setPending(null);
      }}
    >
      <span class="autonomy-line">
        <span class="meta">Autonomy</span>
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form group */}
        <span class="segmented" role="group" aria-label="Autonomy" ref={group} onKeyDown={move}>
          {LEVELS.filter((n) => n <= view.max).map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={n === view.a}
              class={`seg${n === view.a ? " current" : ""}`}
              disabled={off && n !== view.a}
              title={levelTitle(view, n)}
              onClick={() => choose(n)}
            >
              a{n}
              {n === view.a ? <span class="sr-only"> (current)</span> : null}
            </button>
          ))}
        </span>
        {view.cap !== null ? <span class="meta">capped at a{view.cap} by the repo</span> : null}
      </span>
      {view.flag ? (
        // UI-258: where the card is folded into its intent's wait, the flag keeps its own card-like box.
        <section class="needs-card kind-autonomy nested autonomy-flagbox" aria-label="Autonomy raised">
          <span class="meta autonomy-flag">
            {`${view.flag.who === "unknown" ? "An unknown account" : view.flag.who} raised it to a${view.flag.to}. It still runs at a${view.flag.from} until you decide.`}
          </span>
          <FlagButtons intent={intent} view={view} readOnly={readOnly} />
        </section>
      ) : null}
      {pending !== null ? (
        <span
          class="autonomy-confirm"
          role="alertdialog"
          aria-label={`Raise to a${pending}?`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPending(null);
          }}
        >
          <strong>Raise to a{pending}?</strong>
          <span class="meta">{view.notes[pending]}</span>
          <span class="autonomy-buttons">
            <button
              type="button"
              class="btn primary small"
              disabled={busy}
              onClick={() => void save(pending)}
            >
              {busy ? "Raising…" : "Raise"}
            </button>
            <button type="button" class="btn small" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </span>
        </span>
      ) : null}
      {result && !compact ? (
        <span class={result.ok ? "meta" : "meta error"} role="status">
          {result.message}
        </span>
      ) : result && !result.ok ? (
        <span class="meta error" role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}

/** UI-258: the flag card's two ways out. Accepting is a raise, so it asks first. */
export function FlagButtons({
  intent,
  view,
  readOnly,
}: {
  intent: string;
  view: AutonomyView;
  readOnly: boolean;
}) {
  const flag = view.flag;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  if (!flag) return null;
  const go = async (n: number) => {
    setBusy(true);
    setResult(await setAutonomy(intent, n));
    setBusy(false);
    setConfirm(false);
  };
  return (
    <span class="autonomy">
      <span class="autonomy-buttons">
        <button
          type="button"
          class="btn primary"
          disabled={readOnly || busy}
          onClick={() => setConfirm(true)}
        >
          Accept a{flag.to}
        </button>
        <button type="button" class="btn" disabled={readOnly || busy} onClick={() => void go(flag.from)}>
          Set back to a{flag.from}
        </button>
      </span>
      {confirm ? (
        <span
          class="autonomy-confirm"
          role="alertdialog"
          aria-label={`Raise to a${flag.to}?`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirm(false);
          }}
        >
          <strong>Raise to a{flag.to}?</strong>
          <span class="meta">{view.notes[flag.to]}</span>
          <span class="autonomy-buttons">
            <button type="button" class="btn primary small" disabled={busy} onClick={() => void go(flag.to)}>
              Raise
            </button>
            <button type="button" class="btn small" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        </span>
      ) : null}
      {result && !result.ok ? (
        <span class="meta error" role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
