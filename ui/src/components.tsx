// Shared pieces (UI-56 to UI-61, UI-67, UI-70): state chips, times, progress, cards, rows, sections.
// Typed text, results and expanded briefs live in module maps keyed by intent, so a refetch or a
// remount never loses them.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ActionReply,
  Card,
  InstallHelpView,
  Phase,
  ProblemView,
  ProposedCard as ProposedCardData,
  ProposedSection as ProposedData,
  ReadinessBadge,
  RiskView,
  Row,
  SpendView,
  StateView,
  StepView,
  UpNextView,
  When,
} from "../../src/ui/view.ts";
import { AddRepoForm } from "./AddRepo.tsx";
import { AutonomyControl, FlagButtons } from "./AutonomyControl.tsx";
import {
  acceptProposed,
  act,
  approveSecret,
  closeProposed,
  sendSecret,
  tickStep,
  useFreshness,
} from "./api.ts";
import { EstimateBar } from "./budgets.tsx";
import { foldedOn, forgetFold, listFolded, setFolded, setListFolded, waitKey } from "./folds.ts";
import {
  Alert,
  Check,
  ChevronDown,
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
import { asksFirst } from "./options.ts";
import { Link } from "./router.tsx";
import { sharedReason } from "./up-next.ts";

const drafts = new Map<string, string>();
const results = new Map<string, ActionReply>();
const expanded = new Set<string>();
/** UI-126: the "Details" folds a viewer opened, by key, so a refetch keeps them open. */
const detailsOpen = new Set<string>();

/** UI-126, UI-127: the technical text, folded under "Details" until asked for. */
export function Details({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(detailsOpen.has(id));
  return (
    <details
      class="details-fold"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now) detailsOpen.add(id);
        else detailsOpen.delete(id);
        setOpen(now);
      }}
    >
      <summary>Details</summary>
      <div class="details-body">
        <Markdown text={text} />
      </div>
    </details>
  );
}

/** UI-211: how to install the GitHub App on a repo it can't reach, folded under "See more". */
export function InstallHelpBlock({ id, help }: { id: string; help: InstallHelpView }) {
  const [open, setOpen] = useState(detailsOpen.has(`install:${id}`));
  return (
    <details
      class="details-fold install-help"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now) detailsOpen.add(`install:${id}`);
        else detailsOpen.delete(`install:${id}`);
        setOpen(now);
      }}
    >
      <summary>See more</summary>
      <div class="details-body">
        {help.app ? <p>App: {help.app}</p> : null}
        <ol>
          {help.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p>
          <a href={help.url} target="_blank" rel="noopener">
            {help.url}
          </a>
        </p>
      </div>
    </details>
  );
}

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

const RISK_AT = { spec: "the spec", plan: "the plan", code: "the code" };

/** AUT-20: a risk chip and the three answers in plain words. */
export function RiskBlock({ risk }: { risk: RiskView }) {
  return (
    <div class="risk">
      <p class="risk-head">
        <span class={`chip chip-sm risk-${risk.level}`}>{risk.label}</span>
        <span class="meta">judged on {RISK_AT[risk.gate]} by an agent that didn't write it</span>
      </p>
      <ul>
        <li>{risk.blast}</li>
        <li>{risk.door}</li>
        <li>{risk.certainty}</li>
      </ul>
      {risk.raised ? <p class="meta">{risk.raised}</p> : null}
    </div>
  );
}

export function Id({ id }: { id: string }) {
  return <span class="id">{id}</span>;
}

/** UI-236: marks what the shadow wrote or did; a text label, not colour alone. */
export function ShadowTag() {
  return <span class="shadow-tag">[shadow]</span>;
}

/** UI-243: marks what the observer proposed; a text label, not colour alone. */
export function ObserverTag() {
  return <span class="shadow-tag observer-tag">[observer]</span>;
}

/** UI-243: the evidence links and the expected gain of an observer proposal, shown before the rest. */
export function ObserverNote({ note }: { note: { evidence: string; gain: string } }) {
  return (
    <section class="observer-note" aria-label="Evidence and expected gain">
      {note.evidence ? (
        <>
          <p class="access-head">Evidence</p>
          <Markdown text={note.evidence} />
        </>
      ) : null}
      {note.gain ? (
        <>
          <p class="access-head">Expected gain</p>
          <Markdown text={note.gain} />
        </>
      ) : null}
    </section>
  );
}

export function Section(props: {
  title: string;
  count?: number;
  aside?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
  id?: string;
  /** UI-267: the list's name in the browser's fold memory; the header then has a toggle and always a count. */
  fold?: string;
  /** UI-267: open whatever was remembered (a link points inside it). */
  forceOpen?: boolean;
}) {
  const [folded, setFolded] = useState(props.fold ? listFolded(props.fold) : false);
  const hidden = folded && !props.forceOpen;
  const body = `${props.fold ?? "section"}-body`;
  const count = props.count !== undefined && (props.fold || props.count > 0) ? props.count : null;
  return (
    <section class={`section${props.class ? ` ${props.class}` : ""}`} id={props.id} aria-label={props.title}>
      <header class="section-head">
        <h2>
          {props.fold ? (
            <button
              type="button"
              class="section-toggle"
              aria-expanded={!hidden}
              aria-controls={body}
              onClick={() => {
                setListFolded(props.fold!, !hidden);
                setFolded(!hidden);
              }}
            >
              <ChevronDown size={14} class="fold-chev" />
              {props.title}
            </button>
          ) : (
            props.title
          )}
        </h2>
        {count !== null ? <span class="count">{count}</span> : null}
        {props.aside ? <span class="section-aside">{props.aside}</span> : null}
      </header>
      {props.fold ? (
        <div id={body} hidden={hidden}>
          {props.children}
        </div>
      ) : (
        props.children
      )}
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
  foldable = false,
  showSteps = true,
  onActed,
}: {
  card: Card;
  readOnly: boolean;
  linkTitle?: boolean;
  /** UI-245: the checklist of the owner's steps; the intent page shows its own. */
  showSteps?: boolean;
  /** UI-189: the overview lets the card fold to one line. */
  foldable?: boolean;
  /** UI-195: called after an action the loop accepted, so Focus can move on at once. */
  onActed?: (action: string) => void;
}) {
  const key = card.intent;
  const [, redraw] = useState(0);
  // UI-191: folded only while the stored key is this wait's key; a changed wait renders open.
  const wait = waitKey(card);
  const stored = foldable ? foldedOn(key) : undefined;
  const folded = stored !== undefined && stored === wait;
  useEffect(() => {
    if (stored !== undefined && stored !== wait) {
      forgetFold(key);
    }
  }, [key, stored, wait]);
  const fold = () => {
    setFolded(key, wait, !folded);
    redraw((n) => n + 1);
  };
  const [draft, setDraftState] = useState(drafts.get(key) ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ActionReply | null>(results.get(key) ?? null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState(expanded.has(key));
  const [note, setNote] = useState("");
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
    if (r.ok) onActed?.(action);
  };
  const can = (a: string) => !readOnly && card.actions.includes(a as Card["actions"][number]);
  // A plain brief is two to four sentences (PIP-106): shown whole up to about that, folded beyond.
  const long = (card.brief?.length ?? 0) > 480;
  const toggle = () => {
    if (open) expanded.delete(key);
    else expanded.add(key);
    setOpen(!open);
  };
  const q = card.question;
  // UI-164: the question's own options are buttons; the exits it doesn't cover get a button here.
  const askedSteps = !!q?.options.some((o) => o.do === "steps");
  const extra = card.exits.filter(
    (e) => (e.do === "done" || e.do === "steps") && !(e.do === "steps" && askedSteps),
  );
  const pick = (o: { option: string; do?: string }) => {
    if (o.do === "steps") void run("steps");
    else if (o.do === "drop") setConfirm(true);
    else if (o.do === "continue" && !asksFirst(o.option)) void run("reply", o.option);
    else setDraft(o.option);
  };
  const actionBar = (
    <>
      {(can("merge") && card.mergeLabel) || can("pass") || card.pr ? (
        <footer class="card-actions">
          {can("pass") ? (
            <button
              type="button"
              class="btn primary"
              disabled={busy !== null}
              onClick={() => void run("pass")}
            >
              <Merge size={16} />
              {busy === "pass" ? "Passing on…" : "Pass on to teammates"}
            </button>
          ) : null}
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
    </>
  );
  return (
    <article
      class={`card needs-card kind-${card.kind}${card.stuck ? " stuck-card" : ""}${folded ? " folded" : ""}`}
      data-intent={key}
    >
      <header class="card-head">
        {foldable ? (
          // A button by role, not by tag: the card's own list of actions (which Focus must match, UI-195)
          // is its <button>s, and the fold is a view setting, not an action.
          // biome-ignore lint/a11y/useSemanticElements: see above
          <span
            role="button"
            tabIndex={0}
            class="fold-toggle"
            aria-expanded={!folded}
            aria-label={`${folded ? "Open" : "Fold"} ${card.title}`}
            title={`${folded ? "Open" : "Fold"} ${card.title}`}
            onClick={fold}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fold();
              }
            }}
          >
            <ChevronDown size={16} class="fold-chev" />
          </span>
        ) : null}
        {folded ? (
          <span class="fold-line">
            <span class="fold-title">{card.title}</span>
            <span class="fold-repo meta">{card.repo}</span>
            <span class="fold-ask">{card.ask}</span>
            {card.since ? (
              <span class="fold-age meta">
                <Time when={card.since} />
              </span>
            ) : null}
          </span>
        ) : null}
        <span class="chip chip-needs">
          <StateIcon state="needs" size={14} />
          <span>{card.kindLabel}</span>
        </span>
        {card.onlyYou ? <OnlyYou /> : null}
        {card.decided_by_agent ? <span class="chip">agent for owner: {card.decided_by_agent}</span> : null}
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
            {card.kind === "release" && card.pr ? (
              <a href={card.pr.url} target="_blank" rel="noopener noreferrer">
                {card.title}
              </a>
            ) : (
              <Link href={`/i/${key}`}>{card.title}</Link>
            )}
            {card.shadow ? <ShadowTag /> : null}
            {card.observer ? <ObserverTag /> : null}
          </h3>
          <p class="meta">
            {card.repo}
            {card.kind === "release" ? null : (
              <>
                {" · "}
                <Id id={key} />
              </>
            )}
          </p>
        </div>
      ) : null}
      <p class="ask">{card.ask}</p>
      {card.why ? <p class="why">{card.why}</p> : null}
      {card.installHelp ? <InstallHelpBlock id={`card:${key}`} help={card.installHelp} /> : null}
      {card.autonomy ? (
        card.kind === "autonomy" ? (
          <FlagButtons intent={key} view={card.autonomy} readOnly={readOnly} />
        ) : (
          <AutonomyControl intent={key} view={card.autonomy} readOnly={readOnly} compact />
        )
      ) : null}
      {card.warning ? (
        <p class="why review-warning" role="status">
          <Alert size={16} /> {card.warning}
        </p>
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
      {q ? null : actionBar}
      {showSteps && card.steps?.length ? (
        <div class="steps-block card-steps">
          <p class="access-head">Your steps</p>
          <StepsChecklist intent={key} steps={card.steps} readOnly={readOnly} />
        </div>
      ) : null}
      {card.risk ? (
        <details class="risk-fold">
          <summary>{card.risk.line}</summary>
          <RiskBlock risk={card.risk} />
        </details>
      ) : null}
      {card.openPoints?.length ? (
        <details class="access points-fold">
          <summary class="access-head">
            {card.openPoints.length} open point{card.openPoints.length === 1 ? "" : "s"} for you
          </summary>
          <ul class="points">
            {card.openPoints.map((p) => (
              <li key={p.point}>
                <details>
                  <summary>{p.point}</summary>
                  <span class="access-why">{p.why}</span>
                </details>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {q ? (
        <div class="question">
          {card.brief ? null : <p class="q-context">{q.context}</p>}
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
                    disabled={o.do === "steps" || o.do === "drop" ? readOnly : !can("reply")}
                    onClick={() => pick(o)}
                  >
                    <span class="opt-name">
                      {o.option}
                      {rec ? <span class="tag">Recommended</span> : null}
                      {o.do === "steps" ? <span class="tag">Gives you the steps</span> : null}
                      {o.do === "drop" ? <span class="tag">Drops the intent</span> : null}
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
      {card.stuck ? (
        <p class="done-note stuck" role="status">
          <Alert size={16} />
          <span>Stuck: this came back with nothing new</span>
        </p>
      ) : null}
      {extra.length && !readOnly && !card.done ? (
        <div class="exits">
          {extra.some((e) => e.do === "done") ? (
            <>
              <label class="sr-only" for={`note-${key}`}>
                What you did (optional)
              </label>
              <input
                id={`note-${key}`}
                type="text"
                maxLength={300}
                placeholder="What you did (optional)"
                value={note}
                onInput={(e) => setNote((e.target as HTMLInputElement).value)}
              />
            </>
          ) : null}
          {extra.map((e) => (
            <button
              key={e.do}
              type="button"
              class="btn"
              disabled={busy !== null}
              onClick={() => void run(e.do, e.do === "done" ? note : undefined)}
            >
              {busy === e.do ? "Sending…" : e.label}
            </button>
          ))}
        </div>
      ) : null}
      {card.access ? (
        <div class="access">
          <p class="access-head">What the worker may reach beyond the repo</p>
          {card.access.domains.length + card.access.paths.length + (card.access.tests?.length ?? 0) === 0 ? (
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
              {(card.access.tests ?? []).map((t) => (
                <li key={t.path}>
                  <span class="mono">{t.path}</span> (existing test)
                  <span class="access-why">{t.why}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {card.addRepo && !readOnly ? (
        <AddRepoForm name={card.addRepo.name} initial={card.addRepo.github} />
      ) : null}
      {card.details ? <Details id={`card:${key}`} text={card.details} /> : null}
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
      {card.done ? (
        <p class={`done-note${card.done.stuck ? " stuck" : ""}`} role="status">
          {card.done.stuck ? <Alert size={16} /> : <Check size={16} />}
          <span>{card.done.text}</span>
        </p>
      ) : null}
      {q ? actionBar : null}
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

/** SHIP-35: the field for a supplied secret; the value is sent once and the field cleared. */
function SecretField({ intent, step }: { intent: string; step: StepView }) {
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const sec = step.secret!;
  const send = async () => {
    const v = value;
    setValue("");
    const r = await sendSecret(intent, step.n, v);
    setNote(r.message);
  };
  return (
    <div class="secret-field">
      {sec.source === "supply" && !sec.pr ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            type="password"
            autocomplete="off"
            aria-label={`Value for ${sec.key} in ${sec.file}`}
            value={value}
            onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" disabled={!value}>
            Save {sec.key}
          </button>
        </form>
      ) : null}
      {sec.pr ? (
        <p>
          <a href={sec.pr.url} target="_blank" rel="noopener noreferrer">
            Pull request #{sec.pr.number}
          </a>{" "}
          {sec.approved ? (
            "approved; Towercab merges it."
          ) : (
            <button
              type="button"
              onClick={() => void approveSecret(intent, step.n).then((r) => setNote(r.message))}
            >
              Approve secret {sec.key} for {sec.file}
            </button>
          )}
        </p>
      ) : null}
      {sec.error ? (
        <p class="step-why">
          {sec.error}
          {sec.stopped ? (
            <button
              type="button"
              onClick={() => void approveSecret(intent, step.n).then((r) => setNote(r.message))}
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
      {note ? <p class="step-why">{note}</p> : null}
    </div>
  );
}

/** UI-160: the owner's steps, before-merge ones first; ticking one posts the step action. */
export function StepsChecklist({
  intent,
  steps,
  readOnly,
}: {
  intent: string;
  steps: StepView[];
  readOnly: boolean;
}) {
  const group = (when: StepView["when"], title: string) => {
    const list = steps.filter((s) => s.when === when);
    if (!list.length) return null;
    return (
      <>
        <h3>{title}</h3>
        <ul>
          {list.map((s) => (
            <li key={s.n}>
              <label>
                <input
                  type="checkbox"
                  checked={s.doneAt !== null}
                  disabled={readOnly || !!s.secret}
                  onChange={(e) => void tickStep(intent, s.n, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span>
                  {s.text}
                  {s.why ? <span class="step-why">{s.why}</span> : null}
                  {s.doneAt ? (
                    <span class="step-time">
                      Ticked <Time when={s.doneAt} />
                    </span>
                  ) : null}
                </span>
              </label>
              {s.secret && !readOnly && s.doneAt === null ? <SecretField intent={intent} step={s} /> : null}
            </li>
          ))}
        </ul>
      </>
    );
  };
  return (
    <>
      {group("before", "Before the change merges")}
      {group("after", "After the change merges")}
    </>
  );
}

/** UI-59: a moving intent. */
export function WorkRow({ row, readOnly = false }: { row: Row; readOnly?: boolean }) {
  return (
    <Link class="row" href={`/i/${row.intent}`}>
      <span class="row-main">
        <span class="row-title">
          {row.title}
          {row.shadow ? <ShadowTag /> : null}
          {row.observer ? <ObserverTag /> : null}
        </span>
        <span class="meta">
          {row.repo} · <Id id={row.intent} />
        </span>
      </span>
      <span class="row-state">
        <StateChip state={row.state} small />
        <span class="row-step">
          {row.behind ?? row.step}
          {row.build ? <span class="meta build-steps"> · {row.build.label}</span> : null}
          {row.inStep ? <span class="meta"> · {row.inStep}</span> : null}
          {row.warning ? <span class="meta review-warning"> · {row.warning}</span> : null}
        </span>
      </span>
      {row.behind ? null : <Phases phases={row.phases} />}
      {row.autonomy ? (
        <AutonomyControl intent={row.intent} view={row.autonomy} readOnly={readOnly} compact />
      ) : null}
      {row.estimate ? <EstimateBar line={row.estimate} /> : null}
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
        {p.installHelp ? <InstallHelpBlock id={`problem:${p.key}`} help={p.installHelp} /> : null}
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

/** SHD-22, UI-239: pause or resume one intent; at least 44 px tall. */
export function PauseButton({ intent, paused }: { intent: string; paused: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const go = async () => {
    setBusy(true);
    setResult(await act(paused ? "resume" : "pause", intent));
    setBusy(false);
  };
  return (
    <span class="pause-intent">
      <button type="button" class="btn" disabled={busy} onClick={go}>
        {paused ? "Resume this intent" : "Pause this intent"}
      </button>
      {result ? (
        <span class={result.ok ? "meta" : "meta error"} role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}

/** UI-239: the "only you" label: text, not colour alone. */
export function OnlyYou() {
  return <span class="chip chip-only-you">only you</span>;
}

export function UpNextList({ items, start = 1 }: { items: UpNextView[]; start?: number }) {
  // UI-250: a reason every row shares is said once, above the list.
  const shared = sharedReason(items);
  return (
    <>
      {shared ? <p class="up-shared meta">{shared}</p> : null}
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
              {u.reason && !shared ? <span class="up-reason">{u.reason}</span> : null}
              {u.estimate ? <EstimateBar line={u.estimate} /> : null}
              {u.canStart ? <StartButton intent={u.intent} /> : null}
            </div>
          </li>
        ))}
      </ol>
    </>
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

/** UI-155, UI-157: a repo missing setup. Warning colour, never the "Needs you" one. */
export function ReadinessChip({ badge }: { badge: ReadinessBadge | undefined }) {
  if (!badge) return null;
  return (
    <span
      class={`ready-badge${badge.blocks ? " blocks" : ""}`}
      title={badge.detail}
      role="img"
      aria-label={badge.name}
    >
      {badge.label}
    </span>
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

const proposedResults = new Map<number, ActionReply>();

/** UI-184, UI-185: a proposed intent, with its PR, its text, Accept and Close. */
export function ProposedCard({
  card,
  readOnly,
  compact = false,
  onActed,
}: {
  card: ProposedCardData;
  readOnly: boolean;
  /** UI-247: one line (two when it needs a reason or the close box) instead of a card. */
  compact?: boolean;
  /** UI-195: called after Accept or Close went through, so Focus can move on at once. */
  onActed?: (action: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<ActionReply | null>(proposedResults.get(card.pr) ?? null);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const run = async (what: string, call: () => Promise<ActionReply>) => {
    setBusy(what);
    const r = await call();
    proposedResults.set(card.pr, r);
    setResult(r);
    setBusy(null);
    if (r.ok) {
      setClosing(false);
      onActed?.(what);
    }
  };
  const scores = [
    card.u !== null ? `u${card.u}` : "",
    card.i !== null ? `i${card.i}` : "",
    card.a !== null ? `a${card.a}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const why = readOnly ? "Towercab isn't running." : card.acceptWhy;
  if (compact) {
    return (
      <article class="proposed-row" id={`proposed-${card.pr}`}>
        <div class="proposed-line">
          {card.draft ? <span class="chip chip-sm chip-draft">Draft</span> : null}
          <a
            class="proposed-title"
            href={card.textUrl ?? card.prUrl}
            target="_blank"
            rel="noreferrer noopener"
            title="Read the intent"
          >
            {card.title}
          </a>
          {card.observer ? <ObserverTag /> : null}
          <a
            class="proposed-gh"
            href={card.prUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Open on GitHub: ${card.title}`}
            title="Open on GitHub"
          >
            <PullRequest size={14} />
          </a>
          <span class="meta proposed-facts">
            {card.repo ? <span class="mono">{card.repo}</span> : <span>repo unknown</span>}
            {card.priorityText ? <span> · {card.priorityText}</span> : null}
            <span> · {card.waiting}</span>
          </span>
          {closing ? null : (
            <span class="proposed-actions">
              <button
                type="button"
                class="btn primary"
                disabled={readOnly || !card.canAccept || busy !== null}
                title={why ?? undefined}
                onClick={() => run("accept", () => acceptProposed(card.pr, card.head))}
              >
                {busy === "accept" ? "Accepting…" : "Accept"}
              </button>
              <button
                type="button"
                class="btn"
                disabled={readOnly || busy !== null}
                onClick={() => setClosing(true)}
              >
                Close
              </button>
            </span>
          )}
        </div>
        {closing ? (
          <div class="proposed-close">
            <label>
              <span class="meta">Why close it? (optional)</span>
              <input
                type="text"
                value={reason}
                placeholder="Not going ahead."
                onInput={(e) => setReason((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <button
              type="button"
              class="btn"
              disabled={busy !== null}
              onClick={() => run("close", () => closeProposed(card.pr, reason))}
            >
              {busy === "close" ? "Closing…" : "Close the PR"}
            </button>
            <button type="button" class="btn ghost" onClick={() => setClosing(false)}>
              Cancel
            </button>
          </div>
        ) : why ? (
          <p class="meta proposed-why">{why}</p>
        ) : null}
        {result ? (
          <p class={`result ${result.ok ? "ok" : "err"}`} role="status">
            {result.message}
          </p>
        ) : null}
      </article>
    );
  }
  return (
    <article class="card proposed-card" id={`proposed-${card.pr}`}>
      <header class="proposed-head">
        <span class="chip chip-sm">Proposed</span>
        {card.draft ? <span class="chip chip-sm chip-draft">Draft</span> : null}
        <h3>
          {card.title}
          {card.observer ? <ObserverTag /> : null}
        </h3>
      </header>
      <p class="meta proposed-meta">
        {card.repo ? <span class="mono">{card.repo}</span> : <span>repo unknown</span>}
        {scores ? <span class="mono"> · {scores}</span> : null}
        {card.priorityText ? <span> · {card.priorityText}</span> : null}
        <span> · {card.from}</span>
        <span> · {card.waiting}</span>
      </p>
      {card.observerNote ? <ObserverNote note={card.observerNote} /> : null}
      {card.problem ? <p class="proposed-problem">{card.problem}</p> : null}
      <div class="proposed-links">
        <a href={card.prUrl} target="_blank" rel="noreferrer noopener">
          <PullRequest size={14} /> Open on GitHub
        </a>
        {card.textUrl ? (
          <a href={card.textUrl} target="_blank" rel="noreferrer noopener">
            Read the intent
          </a>
        ) : null}
      </div>
      {closing ? (
        <div class="proposed-close">
          <label>
            <span class="meta">Why close it? (optional)</span>
            <input
              type="text"
              value={reason}
              placeholder="Not going ahead."
              onInput={(e) => setReason((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button
            type="button"
            class="btn"
            disabled={busy !== null}
            onClick={() => run("close", () => closeProposed(card.pr, reason))}
          >
            {busy === "close" ? "Closing…" : "Close the PR"}
          </button>
          <button type="button" class="btn ghost" onClick={() => setClosing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div class="proposed-actions">
          <button
            type="button"
            class="btn primary"
            disabled={readOnly || !card.canAccept || busy !== null}
            title={why ?? undefined}
            onClick={() => run("accept", () => acceptProposed(card.pr, card.head))}
          >
            {busy === "accept" ? "Accepting…" : "Accept"}
          </button>
          <button
            type="button"
            class="btn"
            disabled={readOnly || busy !== null}
            onClick={() => setClosing(true)}
          >
            Close
          </button>
          {why ? <span class="meta">{why}</span> : null}
        </div>
      )}
      {result ? (
        <p class={`result ${result.ok ? "ok" : "err"}`} role="status">
          {result.message}
        </p>
      ) : null}
    </article>
  );
}

/** UI-184, UI-186, UI-188, UI-247, UI-267: the proposed rows in order, under a header that folds them. */
export function ProposedList({ data, readOnly, id }: { data: ProposedData; readOnly: boolean; id?: string }) {
  // A link to a proposal (LOOP-93's message) opens the list if it was folded.
  const target = /^#proposed-(\d+)$/.exec(location.hash)?.[1];
  const linked = target !== undefined && data.cards.some((c) => String(c.pr) === target);
  useEffect(() => {
    if (target) document.getElementById(`proposed-${target}`)?.scrollIntoView();
  }, [target]);
  if (!data.cards.length) return null;
  return (
    <Section
      title="Proposed"
      count={data.cards.length}
      id={id}
      class="proposed-section"
      fold="proposed"
      forceOpen={linked}
    >
      {data.stale ? <p class="proposed-stale meta">{data.stale}</p> : null}
      <div class="proposed-rows">
        {data.cards.map((c) => (
          <ProposedCard key={c.pr} card={c} readOnly={readOnly} compact />
        ))}
      </div>
    </Section>
  );
}
