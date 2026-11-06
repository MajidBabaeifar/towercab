// The overview (UI-57 to UI-61, UI-78): what needs me, what is stuck, what is moving, what it costs.

import { useEffect } from "preact/hooks";
import type { Overview as Data } from "../../../src/ui/view.ts";
import { Airspace } from "../Airspace.tsx";
import {
  Empty,
  NeedsCard,
  ProblemItem,
  ProposedList,
  Section,
  SpendCard,
  UpNextList,
  WorkRow,
} from "../components.tsx";
import { pruneFolds } from "../folds.ts";
import { Check, ListIcon, Moon } from "../icons.tsx";
import { Link } from "../router.tsx";

/** UI-244: the one count, split into what the owner sees as cards and what is proposed. */
function headline(n: number, proposed: number): string {
  if (n === 0) return "Nothing needs you.";
  const rest = n - proposed;
  if (proposed === 0) return n === 1 ? "1 thing needs you" : `${n} things need you`;
  return `${n} things need you: ${rest} waiting · ${proposed} proposed`;
}

export function OverviewPage({ data }: { data: Data }) {
  const { top, needs, problems, working, upNext, spend, airspace } = data;
  const oldest = needs.find((c) => c.since)?.since;
  const waiting = needs.map((c) => c.intent).join(",");
  // UI-191: a fold for an intent that no longer waits is forgotten.
  useEffect(() => pruneFolds(waiting ? waiting.split(",") : []), [waiting]);
  return (
    <main class="page overview" id="main">
      <section class={`hero${top.needs ? " hero-needs" : " hero-calm"}`}>
        <h1>{headline(top.needs, top.proposed)}</h1>
        <p class="hero-sub">
          {top.needs
            ? oldest
              ? `The oldest has waited since ${oldest.short}.`
              : "Each card says what is asked and offers only the actions that answer it."
            : "Towercab tells you when something does."}
        </p>
        <ul class="hero-stats">
          <li>
            <strong class="num">{working.length}</strong> working
          </li>
          <li>
            <strong class="num">{top.queued}</strong> queued
          </li>
          <li>
            <strong class="num">{spend.today}</strong> spent today
          </li>
          {problems.length ? (
            <li class="hero-problems">
              <a href="#problems">
                <strong class="num">{problems.length}</strong> problem{problems.length === 1 ? "" : "s"}
              </a>
            </li>
          ) : null}
        </ul>
      </section>
      <Airspace data={airspace} />
      <div class="cols">
        <div class="col-main">
          {needs.length ? (
            <div class="cards">
              {needs.map((c) => (
                <NeedsCard key={c.intent} card={c} readOnly={top.readOnly} foldable />
              ))}
            </div>
          ) : (
            <div class="calm card">
              <Check size={24} />
              <div>
                <p class="calm-title">All clear</p>
                <p class="meta">Every open intent is moving or waiting for its turn.</p>
              </div>
            </div>
          )}
          {problems.length ? (
            <Section title="Problems" count={problems.length} class="problems-section" id="problems">
              <ul class="problems">
                {problems.map((p) => (
                  <ProblemItem key={p.key} p={p} />
                ))}
              </ul>
            </Section>
          ) : null}
          {data.proposed ? <ProposedList data={data.proposed} readOnly={top.readOnly} id="proposed" /> : null}
          <Section title="Working" count={working.length}>
            {working.length ? (
              <div class="rows">
                {working.map((r) => (
                  <WorkRow key={r.intent} row={r} />
                ))}
              </div>
            ) : (
              <Empty text="Nothing is running." icon={<Moon size={18} />} />
            )}
          </Section>
        </div>
        <aside class="col-side">
          <Section title="Up next" aside={<Link href="/repos">Repos</Link>}>
            {upNext.length ? (
              <UpNextList items={upNext} />
            ) : (
              <Empty
                text="Nothing queued: add an intent to the intents repo."
                icon={<ListIcon size={18} />}
              />
            )}
          </Section>
          <Section title="Spend">
            <SpendCard spend={spend} />
          </Section>
          <Section title="Towercab">
            <dl class="facts">
              <div>
                <dt>Health</dt>
                <dd>
                  {problems.length
                    ? `${problems.length} problem${problems.length === 1 ? "" : "s"}`
                    : "No problems."}
                </dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>
                  <span class="mono">{top.version.commit}</span>
                  {top.version.behind ? <span class="meta"> · {top.version.behind}</span> : null}
                </dd>
              </div>
            </dl>
          </Section>
        </aside>
      </div>
    </main>
  );
}
