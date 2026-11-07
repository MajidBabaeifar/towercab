// Budgets and estimates (UI-253 to UI-256): the form, the cap card and the estimate line.

import { useState } from "preact/hooks";
import type { BudgetsView, CapCard, EstimateLine } from "../../src/ui/view.ts";
import { saveBudgets } from "./api.ts";

/** UI-255: the estimate before an intent starts, or spent against it; the bar turns amber when over. */
export function EstimateBar({ line }: { line: EstimateLine }) {
  return (
    <span class={`estimate${line.over ? " amber" : ""}`}>
      <span class="meta">{line.text}</span>
      {line.pct !== null ? (
        <span class="est-bar" role="img" aria-label={`${line.pct}% of the estimate`}>
          <i style={{ width: `${line.pct}%` }} />
        </span>
      ) : null}
    </span>
  );
}

const typed = (n: number | null) => (n === null ? "" : String(n));

/** UI-253: "Per day" and "Per month" for a scope; empty means no limit. */
export function BudgetForm({
  view,
  readOnly,
  title,
  label = "Save budget",
}: {
  view: BudgetsView;
  readOnly: boolean;
  title: string;
  label?: string;
}) {
  const [daily, setDaily] = useState<string | null>(null);
  const [monthly, setMonthly] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = daily ?? typed(view.daily);
  const m = monthly ?? typed(view.monthly);
  const changed = d !== typed(view.daily) || m !== typed(view.monthly);
  const save = async (e: Event) => {
    e.preventDefault();
    const bad = [d, m].some((v) => v !== "" && !(Number(v) > 0 && /^\d+(\.\d{1,2})?$/.test(v.trim())));
    if (bad) {
      setMsg({ ok: false, text: "A budget is a positive amount in USD" });
      return;
    }
    const r = await saveBudgets(view.scope, d === "" ? null : Number(d), m === "" ? null : Number(m));
    setMsg({ ok: r.ok, text: r.message });
    // A refusal keeps what was typed (UI-67); a save shows the stored values again.
    if (r.ok) {
      setDaily(null);
      setMonthly(null);
    }
  };
  return (
    <form class="budget-form" onSubmit={save} aria-label={title}>
      <label>
        <span class="meta">Per day (USD)</span>
        <input
          type="text"
          inputMode="decimal"
          value={d}
          placeholder="no limit"
          disabled={readOnly}
          onInput={(e) => setDaily((e.target as HTMLInputElement).value)}
        />
        <span class="meta">{view.spentDay} spent today</span>
      </label>
      <label>
        <span class="meta">Per month (USD)</span>
        <input
          type="text"
          inputMode="decimal"
          value={m}
          placeholder="no limit"
          disabled={readOnly}
          onInput={(e) => setMonthly((e.target as HTMLInputElement).value)}
        />
        <span class="meta">{view.spentMonth} spent this month</span>
      </label>
      <button type="submit" class="btn primary" disabled={readOnly || !changed}>
        {label}
      </button>
      <p class="meta">{view.where}</p>
      {msg ? (
        <p class={msg.ok ? "meta" : "form-error"} role="status">
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}

/** UI-254: a reached budget or cap, with a one-tap raise. */
export function CapCardView({ card, readOnly }: { card: CapCard; readOnly: boolean }) {
  const [other, setOther] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const raise = async (to: number) => {
    // The same action as the form's; the other period's amount is sent as it is, so only this one changes.
    const r = await saveBudgets(card.scope, ...(card.period === "day" ? [to, undefined] : [undefined, to]));
    setMsg(r.message);
  };
  return (
    <article class="card needs-card cap-card" id={`cap-${card.key}`}>
      <h2 class="card-title">{card.title}</h2>
      <p>{card.line}</p>
      <p class="meta">
        {card.waiting} intent{card.waiting === 1 ? "" : "s"} waiting behind it.
      </p>
      <div class="actions">
        <button type="button" class="btn primary" disabled={readOnly} onClick={() => raise(card.raiseTo)}>
          Raise to ${card.raiseTo}
        </button>
        {other === null ? (
          <button type="button" class="btn ghost" disabled={readOnly} onClick={() => setOther("")}>
            Set a different amount…
          </button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              raise(Number(other));
            }}
          >
            <input
              type="text"
              inputMode="decimal"
              aria-label="New amount in USD"
              value={other}
              onInput={(e) => setOther((e.target as HTMLInputElement).value)}
            />
            <button type="submit" class="btn" disabled={!(Number(other) > 0)}>
              Set
            </button>
          </form>
        )}
      </div>
      {msg ? (
        <p class="meta" role="status">
          {msg}
        </p>
      ) : null}
    </article>
  );
}
