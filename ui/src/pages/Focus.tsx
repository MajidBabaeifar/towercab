// Focus (UI-192 to UI-197): the one wait that needs me most, with enough around it to act on, then the next.
// The card is the Needs you card (UI-58), so Focus has no action of its own.

import { useEffect, useRef, useState } from "preact/hooks";
import type { FocusPage as Data } from "../../../src/ui/view.ts";
import { useLive } from "../api.ts";
import { ErrorNote, NeedsCard, ProposedCard, Skeleton } from "../components.tsx";
import { Check } from "../icons.tsx";
import { Markdown } from "../md.tsx";

/** Waits acted on from this page, left out of the pick until they stop waiting (UI-195). */
const acted = new Set<string>();

function moreWords(n: number): string {
  return `${n} more waiting`;
}

export function FocusPage({ readOnly }: { readOnly: boolean }) {
  const [skip, setSkip] = useState<string[]>([...acted]);
  const live = useLive<Data>(`/api/focus${skip.length ? `?skip=${encodeURIComponent(skip.join(","))}` : ""}`);
  const data = live.data;
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<string | null | undefined>(undefined);
  const key = data ? (data.item?.key ?? null) : undefined;

  // Once the server answered for the skips we sent, forget those that stopped waiting.
  useEffect(() => {
    if (!data || data.asked.join(",") !== skip.join(",")) return;
    const keep = skip.filter((k) => data.skipped.includes(k));
    if (keep.length === skip.length) return;
    acted.clear();
    for (const k of keep) acted.add(k);
    setSkip(keep);
  }, [data, skip]);

  // UI-197: when the next one arrives, the heading takes the keyboard focus.
  useEffect(() => {
    if (key === undefined) return;
    if (shown.current !== undefined && shown.current !== key && key !== null) heading.current?.focus();
    shown.current = key;
  }, [key]);

  if (live.error && !data) return <ErrorNote text={live.error} />;
  if (!data) return <Skeleton />;
  const { item } = data;
  const onActed = () => {
    if (!item) return;
    acted.add(item.key);
    setSkip([...acted]);
  };
  const announce = item
    ? `${item.title}. ${data.more ? moreWords(data.more) : "Nothing else is waiting."}`
    : "Nothing needs you.";
  return (
    <main class="page focus-page" id="main">
      <p class="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {data.stale ? <p class="proposed-stale meta">{data.stale}</p> : null}
      {item ? (
        <article class="focus-item" key={item.key} aria-labelledby="focus-title">
          <p class="focus-repo">{item.repo || "Repo unknown"}</p>
          <h1 id="focus-title" class="focus-title" tabIndex={-1} ref={heading}>
            {item.title}
          </h1>
          {item.overview ? <p class="focus-overview">{item.overview}</p> : null}
          {item.history.length ? (
            <section class="focus-history" aria-labelledby="focus-history-title">
              <h2 id="focus-history-title">So far</h2>
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
            <NeedsCard card={item.card} readOnly={readOnly} linkTitle={false} onActed={onActed} />
          ) : item.proposed ? (
            <ProposedCard card={item.proposed} readOnly={readOnly} onActed={onActed} />
          ) : null}
        </article>
      ) : (
        <div class="focus-empty calm card">
          <Check size={24} />
          <div>
            <h1 class="calm-title">Nothing needs you.</h1>
            <p class="meta">Towercab tells you when something does.</p>
          </div>
        </div>
      )}
      {item && data.more ? <p class="focus-more">{moreWords(data.more)}</p> : null}
    </main>
  );
}
