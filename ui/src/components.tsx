// Shared pieces (UI-56 to UI-61, UI-67, UI-70): state chips, times, progress, cards, rows, sections.
// Typed text, results and expanded briefs live in module maps keyed by intent, so a refetch or a
// remount never loses them.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ActionReply,
  Card,
  Phase,
  ProblemView,
  Row,
  SpendView,
  StateView,
  UpNextView,
  When,
} from "../../src/ui/view.ts";
import { AddRepoForm } from "./AddRepo.tsx";
import { act, useFreshness } from "./api.ts";
import {
  Alert,
  Check,
  External,
  Merge,
  More,
  PullRequest,
  Reply,
  Restart,
  Sparkle,
  StateIcon,
  Trash,
} from "./icons.tsx";
import { Markdown } from "./md.tsx";
import { Link } from "./router.tsx";

const drafts = new Map<string, string>();
const results = new Map<string, ActionReply>();
const expanded = new Set<string>();

export function StateChip({ state, small }: { state: StateView; small?: boolean }) {
  return (
    <span class={`chip chip-${state.key}${small ? " chip-sm" : ""}`}>
      <StateIcon state={state.key} size={small ? 12 : 14} />
      <span>{state.label}</span>
      {state.note ? <span class="chip-note">{state.note}</span> : null}
    </span>
  );
}

export function Time({ when, short }: { when: When; short?: boolean }) {
  return (
    <time dateTime={new Date(when.at * 1000).toISOString()} title={when.exact}>
      {short ? when.short : when.rel}
    </time>
  );
}

export function Id({ id }: { id: string }) {
  return <span class="id">{id}</span>;
}

export function Section(props: {
  title: string;
  count?: number;
  aside?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
  id?: string;
}) {
  return (
    <section class={`section${props.class ? ` ${props.class}` : ""}`} id={props.id} aria-label={props.title}>
      <header class="section-head">
        <h2>{props.title}</h2>
        {props.count !== undefined && props.count > 0 ? <span class="count">{props.count}</span> : null}
        {props.aside ? <span class="section-aside">{props.aside}</span> : null}
      </header>
      {props.children}
    </section>
  );
}

export function Empty({ text, icon }: { text: string; icon?: ComponentChildren }) {
  return (
    <div class="empty">
      {icon ?? <Check size={18} />}
      <p>{text}</p>
    </div>
  );
}

export function Phases({ phases }: { phases: Phase[] }) {
  const words: Record<Phase["status"], string> = {
    done: "done",
    current: "now",
    todo: "to do",
    skipped: "not needed",
  };
  return (
    <ol
      class="phases"
      aria-label={`Progress: ${phases.map((p) => `${p.label} ${words[p.status]}`).join(", ")}`}
    >
      {phases.map((p) => (
        <li key={p.label} class={`phase phase-${p.status}`} title={`${p.label}: ${words[p.status]}`}>
          <span class="phase-mark" aria-hidden="true" />
          <span class="phase-label">{p.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** "Updated 3 s ago" (UI-67). */
export function Freshness() {
  const at = useFreshness();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!at) return <span class="fresh">Loading…</span>;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  const words = s < 2 ? "just now" : s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
  return (
    <span class={`fresh${s > 30 ? " stale" : ""}`} aria-live="off">
      <span class="fresh-dot" aria-hidden="true" />
      <span>
        <span class="fresh-word">Updated </span>
        {words}
      </span>
    </span>
  );
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", on);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", on);
      document.removeEventListener("keydown", key);
    };
  }, [open, close]);
  return ref;
}

const recommended = (rec: string, option: string) => rec.toLowerCase().startsWith(option.toLowerCase());

/** UI-58: one thing waiting on the owner, with only the actions that answer it. */
export function NeedsCard({
  card,
  readOnly,
  linkTitle = true,
}: {
  card: Card;
  readOnly: boolean;
  linkTitle?: boolean;
}) {
  const key = card.intent;
  const [draft, setDraftState] = useState(drafts.get(key) ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ActionReply | null>(results.get(key) ?? null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(expanded.has(key));
  const menuRef = useOutside(menu, () => setMenu(false));
  const setDraft = (t: string) => {
    drafts.set(key, t);
    setDraftState(t);
  };
  const run = async (action: string, text?: string) => {
    setBusy(action);
    setMenu(false);
    const r = await act(action, key, text);
    setBusy(null);
    results.set(key, r);
    setResult(r);
    if (r.ok && action === "reply") setDraft("");
    if (action === "drop") setConfirm(false);
  };
  const can = (a: string) => !readOnly && card.actions.includes(a as Card["actions"][number]);
  const long = (card.brief?.length ?? 0) > 320;
  const toggle = () => {
    if (open) expanded.delete(key);
    else expanded.add(key);
    setOpen(!open);
  };
  const q = card.question;
  return (
    <article class={`card needs-card kind-${card.kind}`} data-intent={key}>
      <header class="card-head">
        <span class="chip chip-needs">
          <StateIcon state="needs" size={14} />
          <span>{card.kindLabel}</span>
        </span>
        <span class="grow" />
        {card.since ? (
          <span class="meta">
            waiting since <Time when={card.since} short />
          </span>
        ) : null}
        {!readOnly && (can("retry") || can("drop")) ? (
          <div class="menu-wrap" ref={menuRef}>
            <button
              type="button"
              class="btn icon-btn"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <More size={18} />
            </button>
            {menu ? (
              <div class="menu" role="menu">
                {can("retry") ? (
                  <button type="button" role="menuitem" onClick={() => void run("retry")}>
                    <Restart size={16} />
                    <span>
                      Start over
                      <small>A fresh attempt from the start</small>
                    </span>
                  </button>
                ) : null}
                {can("drop") ? (
                  <button
                    type="button"
                    role="menuitem"
                    class="danger"
                    onClick={() => {
                      setMenu(false);
                      setConfirm(true);
                    }}
                  >
                    <Trash size={16} />
                    <span>
                      Drop…
                      <small>{card.pr ? "Close the PR and stop" : "Stop working on it"}</small>
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>
      {linkTitle ? (
        <div class="card-titles">
          <h3 class="card-title">
            <Link href={`/i/${key}`}>{card.title}</Link>
          </h3>
          <p class="meta">
            {card.repo} · <Id id={key} />
          </p>
        </div>
      ) : null}
      <p class="ask">{card.ask}</p>
      {card.why ? <p class="why">{card.why}</p> : null}
      {q ? (
        <div class="question">
          <p class="q-context">{q.context}</p>
          <p class="q-text">{q.question}</p>
          <ul class="options">
            {q.options.map((o) => {
              const rec = recommended(q.recommendation, o.option);
              return (
                <li key={o.option}>
                  <button
                    type="button"
                    class={`option${draft === o.option ? " picked" : ""}`}
                    aria-pressed={draft === o.option}
                    disabled={!can("reply")}
                    onClick={() => setDraft(o.option)}
                  >
                    <span class="opt-name">
                      {o.option}
                      {rec ? <span class="tag">Recommended</span> : null}
                    </span>
                    <span class="opt-then">{o.then}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p class="recommend">
            <Sparkle size={14} />
            <span>
              <strong>Towercab recommends:</strong> {q.recommendation}
            </span>
          </p>
        </div>
      ) : null}
      {card.brief ? (
        <div class={`brief${long && !open ? " clamped" : ""}`}>
          <Markdown text={card.brief} />
          {long ? (
            <button type="button" class="link-btn" aria-expanded={open} onClick={toggle}>
              {open ? "Less" : "More"}
            </button>
          ) : null}
        </div>
      ) : null}
      {card.access ? (
        <div class="access">
          <p class="access-head">What the worker may reach beyond the repo</p>
          {card.access.domains.length + card.access.paths.length === 0 ? (
            <p class="meta">Nothing extra: the repo and the usual package sites only.</p>
          ) : (
            <ul>
              {card.access.domains.map((d) => (
                <li key={d.domain}>
                  <span class="mono">{d.domain}</span>
                  <span class="access-why">{d.why}</span>
                </li>
              ))}
              {card.access.paths.map((p) => (
                <li key={p.glob}>
                  <span class="mono">{p.glob}</span>
                  <span class="access-why">{p.why}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {card.addRepo && !readOnly ? (
        <AddRepoForm name={card.addRepo.name} initial={card.addRepo.github} />
      ) : null}
      {can("reply") ? (
        <form
          class="reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void run("reply", draft);
          }}
        >
          <label class="sr-only" for={`reply-${key}`}>
            Your reply
          </label>
          <textarea
            id={`reply-${key}`}
            name="reply"
            rows={3}
            placeholder={q ? "Pick an option above or write your own answer…" : "Write your answer…"}
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          />
          <div class="reply-row">
            <span class="hint">
              {card.pr ? `Posted on the ${card.pr.label} as you.` : "Saved in the intent as your answer."}
            </span>
            <button type="submit" class="btn primary" disabled={!draft.trim() || busy !== null}>
              <Reply size={16} />
              {busy === "reply" ? "Sending…" : "Send reply"}
            </button>
          </div>
        </form>
      ) : null}
      {(can("merge") && card.mergeLabel) || card.pr ? (
        <footer class="card-actions">
          {can("merge") && card.mergeLabel ? (
            <button
              type="button"
              class="btn primary"
              disabled={busy !== null}
              onClick={() => void run("merge")}
            >
              <Merge size={16} />
              {busy === "merge" ? "Merging…" : card.mergeLabel}
            </button>
          ) : null}
          {card.pr ? (
            <a class="btn ghost" href={card.pr.url} target="_blank" rel="noopener noreferrer">
              <PullRequest size={16} />
              {card.pr.label}
              <External size={14} class="muted-icon" />
            </a>
          ) : null}
        </footer>
      ) : null}
      {readOnly ? <p class="meta readonly-note">Read-only: Towercab isn't running.</p> : null}
      {confirm ? (
        <div class="confirm" role="alertdialog" aria-label="Confirm drop">
          <p>
            Drop “{card.title}”?{" "}
            {card.pr
              ? `This closes the ${card.pr.label} and stops the intent.`
              : "Towercab stops working on it."}
          </p>
          <div class="confirm-row">
            <button
              type="button"
              class="btn danger"
              disabled={busy !== null}
              onClick={() => void run("drop")}
            >
              {busy === "drop" ? "Dropping…" : "Drop it"}
            </button>
            <button type="button" class="btn ghost" onClick={() => setConfirm(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : null}
      {result ? (
        <p class={`result ${result.ok ? "ok" : "err"}`} role="status">
          {result.ok ? <Check size={16} /> : <Alert size={16} />}
          <span>{result.message}</span>
        </p>
      ) : null}
    </article>
  );
}

/** UI-59: a moving intent. */
export function WorkRow({ row }: { row: Row }) {
  return (
    <Link class="row" href={`/i/${row.intent}`}>
      <span class="row-main">
        <span class="row-title">{row.title}</span>
        <span class="meta">
          {row.repo} · <Id id={row.intent} />
        </span>
      </span>
      <span class="row-state">
        <StateChip state={row.state} small />
        <span class="row-step">
          {row.behind ?? row.step}
          {row.inStep ? <span class="meta"> · {row.inStep}</span> : null}
        </span>
      </span>
      {row.behind ? null : <Phases phases={row.phases} />}
      <span class="row-num">
        <span class="num">{row.cost}</span>
        <span class="meta">{row.model}</span>
      </span>
    </Link>
  );
}

export function ProblemItem({ p }: { p: ProblemView }) {
  return (
    <li class={`problem tone-${p.tone}`}>
      <Alert size={18} />
      <div class="problem-body">
        <p class="problem-title">{p.title}</p>
        {p.detail ? <p class={`problem-detail${p.code ? " code" : ""}`}>{p.detail}</p> : null}
        <p class="problem-fix">{p.fix}</p>
      </div>
      {p.intent ? (
        <Link class="btn ghost small" href={`/i/${p.intent}`}>
          Open
        </Link>
      ) : null}
    </li>
  );
}

/** UI-101: begin an intent's design now, over the repo's limit. */
export function StartButton({ intent }: { intent: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const go = async () => {
    setBusy(true);
    setResult(await act("start", intent));
    setBusy(false);
  };
  return (
    <span class="start-now">
      <button type="button" class="btn" disabled={busy} onClick={go}>
        Start now
      </button>
      {result ? (
        <span class={result.ok ? "meta" : "meta error"} role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}

export function UpNextList({ items, start = 1 }: { items: UpNextView[]; start?: number }) {
  return (
    <ol class="upnext">
      {items.map((u, n) => (
        <li key={u.intent} class={`up up-${u.state.key}`}>
          <span class="pos">{n + start}</span>
          <div class="up-body">
            <Link class="up-title" href={`/i/${u.intent}`}>
              {u.title}
            </Link>
            <span class="up-meta">
              <StateChip state={u.state} small />
              <span class="meta">
                {u.repo} · priority {u.priority}
              </span>
            </span>
            {u.reason ? <span class="up-reason">{u.reason}</span> : null}
            {u.canStart ? <StartButton intent={u.intent} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function SpendCard({ spend }: { spend: SpendView }) {
  const top = Math.max(...spend.days.map((d) => d.cost), 0.01);
  // The budget line only when it is within reach of the bars; otherwise it flattens them.
  const showBudget = spend.budgetUsd !== null && spend.budgetUsd <= top * 1.5;
  const max = showBudget ? Math.max(top, spend.budgetUsd ?? 0) : top;
  const w = 32;
  const gap = 10;
  const h = 72;
  const pct = spend.budgetUsd ? Math.min(100, (spend.todayUsd / spend.budgetUsd) * 100) : 0;
  const over = spend.budgetUsd !== null && spend.todayUsd >= spend.budgetUsd;
  return (
    <div class="spend">
      <div class="spend-top">
        <span class="big num">{spend.today}</span>
        <span class="meta">today{spend.budget ? ` of ${spend.budget}` : ""}</span>
      </div>
      {spend.budgetUsd ? (
        <svg
          class={`meter${over ? " over" : pct > 80 ? " near" : ""}`}
          viewBox="0 0 100 6"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect class="meter-track" width="100" height="6" rx="3" />
          {pct > 0 ? <rect class="meter-fill" width={Math.max(pct, 2)} height="6" rx="3" /> : null}
        </svg>
      ) : null}
      {spend.days.some((d) => d.cost > 0) ? (
        <>
          <svg
            class="bars"
            viewBox={`0 0 ${7 * w + 6 * gap} ${h}`}
            role="img"
            aria-label={`Spend per day, last 7 days: ${spend.days.map((d) => `${d.label} ${d.text}`).join(", ")}`}
          >
            {showBudget && spend.budgetUsd ? (
              <line
                class="budget-line"
                x1="0"
                x2={7 * w + 6 * gap}
                y1={h - (spend.budgetUsd / max) * (h - 4)}
                y2={h - (spend.budgetUsd / max) * (h - 4)}
              />
            ) : null}
            {spend.days.map((d, n) => {
              const bh = d.cost > 0 ? Math.max(3, (d.cost / max) * (h - 4)) : 2;
              return (
                <rect
                  key={d.date}
                  class={`bar${n === 6 ? " today" : ""}${d.cost === 0 ? " zero" : ""}`}
                  x={n * (w + gap)}
                  y={h - bh}
                  width={w}
                  height={bh}
                  rx="4"
                >
                  <title>{`${d.label} ${d.date}: ${d.text}`}</title>
                </rect>
              );
            })}
          </svg>
          <div class="bar-labels" aria-hidden="true">
            {spend.days.map((d, n) => (
              <span key={d.date} class={n === 6 ? "today" : undefined}>
                {n === 6 ? "Today" : d.label}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p class="spend-none">No runs in the last 7 days.</p>
      )}
      <p class="meta spend-week">
        <span class="num">{spend.week}</span> in the last 7 days
      </p>
    </div>
  );
}

export function ErrorNote({ text }: { text: string }) {
  return (
    <div class="error-note" role="alert">
      <Alert size={18} />
      <p>{text}</p>
    </div>
  );
}

export function Skeleton() {
  return (
    <div class="skeleton" role="status" aria-busy="true" aria-label="Loading">
      <div />
      <div />
      <div />
    </div>
  );
}
