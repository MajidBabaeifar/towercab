// UI-203, UI-205, UI-207, UI-208: urgency and importance as 1–5 controls, the Boost button with its confirm,
// and the lines that say why a boosted plane waits or that a worker lowered the level.

import { useRef, useState } from "preact/hooks";
import type { ActionReply, ControlsView } from "../../src/ui/view.ts";
import { boostIntent, setKind, setScores } from "./api.ts";

const SCORES = [1, 2, 3, 4, 5];

/** A click inside a row's link must not follow the link. */
const still = (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
};

/** UI-203: one segmented control, 1 to 5; arrow keys move between the choices. */
function Scale({
  label,
  value,
  disabled,
  onPick,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onPick: (n: number) => void;
}) {
  const group = useRef<HTMLSpanElement>(null);
  const move = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const all = [...(group.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(at + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]?.focus();
    e.preventDefault();
  };
  return (
    <span class="autonomy-line">
      <span class="meta">{label}</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form group */}
      <span class="segmented" role="group" aria-label={label} ref={group} onKeyDown={move}>
        {SCORES.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={n === value}
            class={`seg${n === value ? " current" : ""}`}
            disabled={disabled && n !== value}
            onClick={() => n !== value && onPick(n)}
          >
            {n}
            {n === value ? <span class="sr-only"> (current)</span> : null}
          </button>
        ))}
      </span>
    </span>
  );
}

/** UI-203: urgency and importance on the intent page; the priority and parked state show at once. */
export function ScoreControl({
  intent,
  view,
  readOnly,
}: {
  intent: string;
  view: ControlsView;
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const save = async (change: { u?: number; i?: number }) => {
    setBusy(true);
    setResult(await setScores(intent, change));
    setBusy(false);
  };
  const off = readOnly || busy;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click here must not follow the row's link
    <span class="autonomy scores" onClick={still} onKeyDown={still}>
      <Scale label="Urgency" value={view.u} disabled={off} onPick={(u) => void save({ u })} />
      <Scale label="Importance" value={view.i} disabled={off} onPick={(i) => void save({ i })} />
      <span class="meta">
        Priority {view.priority}
        {view.parked ? " · parked: raise urgency or importance to run it" : ""}
      </span>
      {result && !result.ok ? (
        <span class="meta error" role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}

/** UI-205: Boost, with the confirm of a raise that names a5; nothing is written until "Boost". */
export function BoostButton({ intent, view }: { intent: string; view: ControlsView }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const go = async () => {
    setBusy(true);
    setResult(await boostIntent(intent));
    setBusy(false);
    setAsking(false);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click here must not follow the row's link
    <span
      class="autonomy boost"
      onClick={still}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") setAsking(false);
      }}
    >
      <button type="button" class="btn" disabled={busy} onClick={() => setAsking(true)}>
        Boost
      </button>
      {asking ? (
        <span class="autonomy-confirm" role="alertdialog" aria-label="Boost?">
          <strong>Boost? Raise to a5?</strong>
          <span class="meta">{view.boostNote}</span>
          <span class="autonomy-buttons">
            <button type="button" class="btn primary small" disabled={busy} onClick={() => void go()}>
              {busy ? "Boosting…" : "Boost"}
            </button>
            <button type="button" class="btn small" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </span>
        </span>
      ) : null}
      {result ? (
        <span class={result.ok ? "meta" : "meta error"} role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}

/** UI-207, UI-208: why a boosted plane waits, and that a worker lowered the level. */
export function ControlNotes({ view }: { view: ControlsView }) {
  return (
    <>
      {view.waitWhy ? <span class="meta">{view.waitWhy}</span> : null}
      {view.lowered ? <span class="meta">{view.lowered}</span> : null}
    </>
  );
}

/** UI-283: the intent's kind, why it was guessed, what it skips, and the choice of another kind. */
export function KindControl({
  intent,
  view,
  readOnly,
}: {
  intent: string;
  view: ControlsView;
  readOnly: boolean;
}) {
  const k = view.kind;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const pick = async (kind: string) => {
    setBusy(true);
    setResult(await setKind(intent, kind));
    setBusy(false);
  };
  return (
    <span class="autonomy kind" data-kind={k.value}>
      <span class="meta">
        Kind: <strong>{k.label}</strong>
        {k.by === "guess" ? " (Towercab's guess)" : ""}
        {k.why ? ` · ${k.why}` : ""}
      </span>
      {k.skipped.map((s) => (
        <span class="meta" key={s}>
          {s}
        </span>
      ))}
      {k.canSet && !readOnly ? (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form group
        <span class="segmented" role="group" aria-label="Kind">
          {k.options.map((o) => (
            <button
              key={o.value}
              type="button"
              class={`seg${o.value === k.value ? " current" : ""}`}
              aria-pressed={o.value === k.value}
              disabled={busy || (o.refused !== null && o.value !== k.value)}
              title={o.refused ?? undefined}
              onClick={() => o.value !== k.value && void pick(o.value)}
            >
              {o.label}
            </button>
          ))}
        </span>
      ) : null}
      {k.options
        .filter((o) => o.refused && o.value !== k.value)
        .map((o) => (
          <span class="meta" key={`r-${o.value}`}>
            {o.label}: {o.refused}
          </span>
        ))}
      {result ? (
        <span class={result.ok ? "meta" : "meta error"} role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
