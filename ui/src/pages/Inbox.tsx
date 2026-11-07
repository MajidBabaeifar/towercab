// The Inbox (UI-259 to UI-264): everything that needs me in one list, the selected item beside it, and keys to
// go through it. The cards are the Needs you card, the proposal and the cap card: the Inbox has no action of
// its own, except `m`, which asks before it posts the card's own merge.

import { useEffect, useRef, useState } from "preact/hooks";
import type { InboxPage as Data, InboxItem } from "../../../src/ui/view.ts";
import { act, markSeen, snoozeItem, unsnoozeItem, useLive } from "../api.ts";
import { CapCardView } from "../budgets.tsx";
import { ErrorNote, NeedsCard, ProposedCard, Section, Skeleton } from "../components.tsx";
import { Check } from "../icons.tsx";
import { actsOnEnter, ignored, openShortcuts } from "../keys.ts";
import { Modal } from "../Modal.tsx";
import { Markdown } from "../md.tsx";
import { Link, navigate } from "../router.tsx";

const SEEN_AFTER_MS = 3000;
const PHONE = "(max-width: 639px)";

/** `5 min`, `3 h`, `2 d` since `since` (unix s). */
function ageOf(since: number | null): string {
  if (since === null) return "";
  const s = Math.max(0, Date.now() / 1000 - since);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

/** UI-264's three choices, in the browser's time zone. */
export function snoozeChoices(from = new Date()): { label: string; until: number }[] {
  const at8 = (add: number) => {
    const d = new Date(from);
    d.setDate(d.getDate() + add);
    d.setHours(8, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  const toMonday = (8 - from.getDay()) % 7 || 7;
  return [
    { label: "1 hour", until: Math.floor(from.getTime() / 1000) + 3600 },
    { label: "Until tomorrow 08:00", until: at8(1) },
    { label: "Until Monday 08:00", until: at8(toMonday) },
  ];
}

function whenText(until: number): string {
  return new Date(until * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function usePhone(): boolean {
  const [on, setOn] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const m = matchMedia(PHONE);
    const f = () => setOn(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return on;
}

function Detail({ item, readOnly, onSnooze }: { item: InboxItem; readOnly: boolean; onSnooze(): void }) {
  return (
    <article class="inbox-detail" aria-labelledby="inbox-detail-title" data-item={item.key}>
      <p class="focus-repo">{item.repo || (item.kind === "cap" ? "Budget" : "Repo unknown")}</p>
      <h2 id="inbox-detail-title" class="focus-title" tabIndex={-1}>
        {item.title}
      </h2>
      <p class="inbox-detail-links meta">
        {item.kind === "card" && item.card?.kind !== "release" ? (
          <>
            <Link href={`/i/${item.key}`}>Open the intent page</Link>
            {" · "}
          </>
        ) : null}
        {readOnly ? null : (
          <button type="button" class="link-btn" onClick={onSnooze}>
            Snooze
          </button>
        )}
      </p>
      {item.overview ? <p class="focus-overview">{item.overview}</p> : null}
      {item.history.length ? (
        <section class="focus-history" aria-labelledby="inbox-history-title">
          <h3 id="inbox-history-title">So far</h3>
          <ol>
            {item.history.map((h) => (
              <li key={h.label}>
                <strong>{h.label}</strong>
                <Markdown text={h.text} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {item.card ? (
        <NeedsCard card={item.card} readOnly={readOnly} linkTitle={false} />
      ) : item.proposed ? (
        <ProposedCard card={item.proposed} readOnly={readOnly} />
      ) : item.cap ? (
        <CapCardView card={item.cap} readOnly={readOnly} />
      ) : null}
    </article>
  );
}

export function InboxPage({
  readOnly,
  selected,
  search,
}: {
  readOnly: boolean;
  /** The item in the URL (`/inbox/<id>`); null shows the first. */
  selected: string | null;
  search: string;
}) {
  const live = useLive<Data>("/api/inbox");
  const data = live.data;
  const phone = usePhone();
  const q = new URLSearchParams(search).get("q") ?? "";
  const [, redraw] = useState(0);
  const [note, setNote] = useState("");
  const [merging, setMerging] = useState<InboxItem | null>(null);
  const [snoozing, setSnoozing] = useState<InboxItem | null>(null);
  /** Items marked New while this page has been open: rows don't change under the owner's eyes (UI-264). */
  const fresh = useRef(new Set<string>());
  /** Items the owner opened: their marker stays off while the server still says New. */
  const cleared = useRef(new Set<string>());
  const lastIdx = useRef(0);
  const listScroll = useRef(0);
  const focusRow = useRef(false);
  const focusDetail = useRef(false);
  const filter = useRef<HTMLInputElement>(null);

  // UI-264: the page was visible for 3 s, so the server stamps the visit. A reload closed at once marks nothing.
  const loaded = data !== null;
  useEffect(() => {
    if (!loaded || readOnly) return;
    let timer: number | undefined;
    const start = () => {
      if (document.visibilityState === "visible" && timer === undefined)
        timer = window.setTimeout(() => void markSeen(), SEEN_AFTER_MS);
    };
    const stop = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const onVis = () => (document.visibilityState === "visible" ? start() : stop());
    document.addEventListener("visibilitychange", onVis);
    start();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [loaded, readOnly]);

  // UI-266: an old link, `/#proposed-<PR>` or `/#needs-<id>`, opens its item, or the overview when it is gone.
  const redirected = useRef(false);
  useEffect(() => {
    if (!data || redirected.current) return;
    redirected.current = true;
    const m = /^#(proposed-\d+|needs-([A-Za-z0-9._-]+))$/.exec(location.hash);
    if (!m) return;
    const key = m[2] ?? m[1]!;
    if (data.items.some((i) => i.key === key)) navigate(`/inbox/${key}`, { replace: true });
    else navigate(`/overview${location.hash}`, { replace: true });
  }, [data]);

  // A wake time passing hides nothing new from the server's view: redraw when the next one is due.
  const wakes = (data?.items ?? []).map((i) => i.snoozedUntil).filter((u): u is number => u !== null);
  const nextWake = wakes.length ? Math.min(...wakes) : null;
  useEffect(() => {
    if (nextWake === null) return;
    const ms = Math.max(0, nextWake * 1000 - Date.now()) + 50;
    const t = window.setTimeout(() => redraw((n) => n + 1), Math.min(ms, 2_147_000_000));
    return () => window.clearTimeout(t);
  }, [nextWake]);

  const nowS = Date.now() / 1000;
  const items = data?.items ?? [];
  for (const i of items) {
    if (!i.new) cleared.current.delete(i.key);
    else if (cleared.current.has(i.key)) continue;
    if (i.new || (i.snoozedUntil !== null && i.snoozedUntil <= nowS)) fresh.current.add(i.key);
  }
  const matches = (i: InboxItem) => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return [i.title, i.repo, i.key, i.pr === null ? "" : String(i.pr), i.pr === null ? "" : `#${i.pr}`].some(
      (s) => s.toLowerCase().includes(t),
    );
  };
  const snoozedNow = (i: InboxItem) => i.snoozedUntil !== null && i.snoozedUntil > nowS;
  const main = items.filter((i) => !snoozedNow(i) && matches(i));
  const aside = items.filter((i) => snoozedNow(i) && matches(i));

  // The item shown: the one in the URL, else the first. One that ended gives way to the next row.
  const inUrl = selected ? items.find((i) => i.key === selected) : undefined;
  const fallback = main[Math.min(lastIdx.current, main.length - 1)] ?? null;
  const sel: InboxItem | null = inUrl ?? (phone ? null : selected ? fallback : (main[0] ?? null));
  const idx = sel ? main.findIndex((i) => i.key === sel.key) : -1;
  if (idx >= 0) lastIdx.current = idx;
  const showCard = phone && selected !== null && sel !== null;

  // UI-260: back on the list, it is where it was.
  const wasCard = useRef(false);
  useEffect(() => {
    if (wasCard.current && !showCard) scrollTo(0, listScroll.current);
    wasCard.current = showCard;
  }, [showCard]);

  const go = (key: string, o: { focus?: "row" | "detail"; push?: boolean } = {}) => {
    fresh.current.delete(key);
    cleared.current.add(key);
    focusRow.current = o.focus === "row";
    focusDetail.current = o.focus === "detail";
    if (phone && o.push) listScroll.current = scrollY;
    navigate(`/inbox/${key}${search}`, { replace: !(phone && o.push), keepScroll: !phone });
    // Already selected: nothing re-renders the selection, so the focus is moved here.
    if (o.focus === "detail")
      window.setTimeout(() => document.getElementById("inbox-detail-title")?.focus(), 30);
  };
  const selKey = sel?.key ?? null;
  useEffect(() => {
    if (selKey === null) return;
    if (focusRow.current) document.getElementById(`inbox-row-${selKey}`)?.focus();
    else if (focusDetail.current) document.getElementById("inbox-detail-title")?.focus();
    focusRow.current = false;
    focusDetail.current = false;
  }, [selKey, showCard]);

  const say = (t: string) => {
    setNote("");
    window.setTimeout(() => setNote(t), 20);
  };
  const back = () => navigate(`/inbox${search}`, { keepScroll: true });

  // UI-261: the keys. One handler, always the latest state.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if (ignored(e)) return;
    const k = e.key;
    const step = (d: number) => {
      const at = Math.max(0, Math.min(main.length - 1, Math.max(0, idx) + d));
      const to = main[at];
      if (to && to.key !== sel?.key) go(to.key, { focus: "row" });
      else if (to) document.getElementById(`inbox-row-${to.key}`)?.focus();
    };
    if (k === "j" || k === "k") {
      e.preventDefault();
      step(k === "j" ? 1 : -1);
    } else if (k === "Enter") {
      if (actsOnEnter(e) || !sel) return;
      e.preventDefault();
      go(sel.key, { focus: "detail", push: true });
    } else if (k === "Escape") {
      if (showCard) back();
      else if (sel) document.getElementById(`inbox-row-${sel.key}`)?.focus();
    } else if (k === "/") {
      e.preventDefault();
      filter.current?.focus();
    } else if (k === "m") {
      if (sel?.merge && !readOnly) setMerging(sel);
      else say("m merges a spec, plan or code pull request; this item has none to merge.");
    } else if (k === "r") {
      const box = document.querySelector<HTMLTextAreaElement>(".inbox-detail textarea");
      if (box) {
        e.preventDefault();
        box.focus();
      } else say("There is nothing to answer on this item.");
    } else if (k === "o") {
      if (sel?.prUrl) window.open(sel.prUrl, "_blank", "noopener,noreferrer");
      else say("This item has no pull request.");
    } else if (k === "s") {
      if (sel && !readOnly) {
        e.preventDefault();
        setSnoozing(sel);
      }
    } else if (k === "?") {
      e.preventDefault();
      openShortcuts();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  if (live.error && !data) return <ErrorNote text={live.error} />;
  if (!data) return <Skeleton />;
  const newCount = items.filter((i) => fresh.current.has(i.key) && !snoozedNow(i)).length;
  const snoozedCount = items.filter(snoozedNow).length;
  const setQ = (v: string) => {
    const p = new URLSearchParams(search);
    if (v) p.set("q", v);
    else p.delete("q");
    const s = p.toString();
    navigate(`${location.pathname}${s ? `?${s}` : ""}`, { replace: true, keepScroll: true });
  };
  const row = (i: InboxItem, snoozed: boolean) => {
    const on = i.key === sel?.key;
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: Enter is the page's key handler (UI-261)
      <div
        key={i.key}
        id={`inbox-row-${i.key}`}
        role="option"
        aria-selected={on}
        tabIndex={on || (sel === null && i === main[0]) ? 0 : -1}
        class={`inbox-row${on ? " on" : ""}`}
        onClick={() => go(i.key, { focus: phone ? "detail" : undefined, push: true })}
      >
        <span class="chip chip-needs chip-sm">{i.kindLabel}</span>
        <span class="inbox-title">{i.title}</span>
        {fresh.current.has(i.key) ? <span class="chip-new">New</span> : null}
        <span class="inbox-meta meta">
          {i.repo}
          {i.since !== null ? ` · ${ageOf(i.since)}` : ""}
        </span>
        {snoozed && i.snoozedUntil !== null ? (
          <span class="inbox-wake meta">
            until {whenText(i.snoozedUntil)}{" "}
            <button
              type="button"
              class="link-btn"
              onClick={(e) => {
                e.stopPropagation();
                void unsnoozeItem(i.key).then((r) => say(r.message));
              }}
            >
              Unsnooze
            </button>
          </span>
        ) : null}
      </div>
    );
  };
  return (
    <main class={`page inbox${showCard ? " inbox-card" : ""}`} id="main">
      <p class="sr-only" role="status" aria-live="polite">
        {note || (sel ? `${sel.title}. ${main.length} in the list.` : "Nothing needs you.")}
      </p>
      {note ? (
        <p class="inbox-note meta" aria-hidden="true">
          {note}
        </p>
      ) : null}
      {data.stale ? <p class="proposed-stale meta">{data.stale}</p> : null}
      <header class="inbox-head">
        <h1>Inbox</h1>
        <p class="inbox-count">
          {data.needs} need{data.needs === 1 ? "s" : ""} you
          {snoozedCount ? ` · ${snoozedCount} snoozed` : ""}
          {newCount ? ` · ${newCount} new` : ""}
        </p>
        <button type="button" class="link-btn inbox-hint" onClick={openShortcuts}>
          ? shortcuts
        </button>
      </header>
      {data.needs === 0 ? (
        <div class="focus-empty calm card">
          <Check size={24} />
          <div>
            <p class="calm-title">Nothing needs you.</p>
            <p class="meta">Towercab tells you when something does.</p>
          </div>
        </div>
      ) : (
        <div class="inbox-grid">
          <div class="inbox-list">
            <div class="inbox-filter">
              <input
                ref={filter}
                type="search"
                aria-label="Filter the inbox"
                placeholder="Filter by title, repo, ID or PR number"
                value={q}
                onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
              />
              {q ? (
                <span class="meta inbox-shown">
                  {main.length + aside.length} of {data.needs}
                </span>
              ) : null}
            </div>
            <Section title="Needs you" count={main.length} fold="inbox" class="inbox-section">
              <div role="listbox" aria-label="Inbox" class="inbox-rows">
                {main.map((i) => row(i, false))}
              </div>
              {main.length === 0 ? <p class="meta">Nothing in the list{q ? " matches" : ""}.</p> : null}
            </Section>
            {aside.length ? (
              <Section title="Snoozed" count={aside.length} fold="inbox-snoozed" class="inbox-section">
                <div role="listbox" aria-label="Snoozed" class="inbox-rows">
                  {aside.map((i) => row(i, true))}
                </div>
              </Section>
            ) : null}
          </div>
          <div class="inbox-pane">
            {showCard ? (
              <button type="button" class="btn ghost inbox-back" onClick={back}>
                Back to the inbox
              </button>
            ) : null}
            {sel ? (
              <Detail key={sel.key} item={sel} readOnly={readOnly} onSnooze={() => setSnoozing(sel)} />
            ) : (
              <p class="meta">Nothing matches the filter.</p>
            )}
          </div>
        </div>
      )}
      {merging ? (
        <Modal label="Merge" onClose={() => setMerging(null)} focus=".confirm-no">
          <h2 class="modal-title">
            Merge {merging.card?.pr ? `${merging.card.pr.label}: ` : ""}
            {merging.title}?
          </h2>
          <p>
            {merging.card?.mergeLabel ?? "Merge"} in {merging.repo || "its repo"}. Nothing happens until you
            merge.
          </p>
          <div class="modal-actions">
            <button type="button" class="btn confirm-no" onClick={() => setMerging(null)}>
              Cancel
            </button>
            <button
              type="button"
              class="btn primary"
              onClick={() => {
                const it = merging;
                setMerging(null);
                void act("merge", it.key).then((r) => say(r.message));
              }}
            >
              Merge
            </button>
          </div>
        </Modal>
      ) : null}
      {snoozing ? (
        <Modal label="Snooze" onClose={() => setSnoozing(null)} focus=".snooze-choice">
          <h2 class="modal-title">Snooze “{snoozing.title}”</h2>
          <p class="meta">It still counts as needing you, and comes back marked New.</p>
          <div class="modal-actions snooze-actions">
            {snoozeChoices().map((c) => (
              <button
                key={c.label}
                type="button"
                class="btn snooze-choice"
                onClick={() => {
                  const it = snoozing;
                  setSnoozing(null);
                  void snoozeItem(it.key, c.until).then((r) =>
                    say(r.ok ? `Snoozed until ${whenText(c.until)}.` : r.message),
                  );
                }}
              >
                {c.label}
              </button>
            ))}
            <button type="button" class="btn ghost" onClick={() => setSnoozing(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}
