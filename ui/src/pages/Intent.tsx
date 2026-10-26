// One intent's whole story (UI-62, MET-30): state, the three PRs, the timeline, time per step, cost,
// the intent's own text and its run files.

import type { IntentPage as Data, PrView } from "../../../src/ui/view.ts";
import { Id, NeedsCard, Section, StateChip, Time } from "../components.tsx";
import { ChevronLeft, External, FileText, PullRequest } from "../icons.tsx";
import { Markdown } from "../md.tsx";
import { Link } from "../router.tsx";

const PR_WORDS: Record<PrView["state"], string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  "not needed": "Not needed",
  "not yet": "Not yet",
};

function PrTile({ pr }: { pr: PrView }) {
  const body = (
    <>
      <span class="pr-label">{pr.label}</span>
      <span class={`pr-state pr-${pr.state.replace(" ", "-")}`}>
        <PullRequest size={14} />
        {PR_WORDS[pr.state]}
        {pr.number !== null ? <span class="pr-num">#{pr.number}</span> : null}
      </span>
    </>
  );
  return pr.url ? (
    <a class="pr-tile" href={pr.url} target="_blank" rel="noopener noreferrer">
      {body}
      <External size={14} class="pr-ext" />
    </a>
  ) : (
    <div class="pr-tile pr-none">{body}</div>
  );
}

export function IntentPage({ data, readOnly }: { data: Data; readOnly: boolean }) {
  const max = Math.max(...data.times.steps.map((s) => s.secs), 1);
  return (
    <main class="page intent" id="main">
      <Link class="back" href="/">
        <ChevronLeft size={16} />
        Overview
      </Link>
      <header class="intent-head">
        <div class="intent-title">
          <h1>{data.title}</h1>
          <p class="meta">
            {data.repo} · <Id id={data.id} />
            {data.scores ? ` · ${data.scores}` : ""}
          </p>
        </div>
        <StateChip state={data.state} />
      </header>
      <p class="sentence">{data.sentence}</p>
      <section class="prs" aria-label="Pull requests">
        {data.prs.map((p) => (
          <PrTile key={p.label} pr={p} />
        ))}
      </section>
      {data.card ? <NeedsCard card={data.card} readOnly={readOnly} linkTitle={false} /> : null}
      <div class="cols">
        <div class="col-main">
          <Section title="Timeline" count={data.timeline.length}>
            {data.timeline.length ? (
              <ol class="timeline">
                {data.timeline.map((t, n) => (
                  <li key={n} class={`tl tl-${t.tone}`}>
                    <span class="tl-time">
                      <Time when={t.at} short />
                    </span>
                    <span class="tl-dot" aria-hidden="true" />
                    <div class="tl-body">
                      <p class="tl-text">{t.text}</p>
                      {t.why ? <p class="tl-why">{t.why}</p> : null}
                    </div>
                    <span class="tl-lasted meta">
                      {t.lasted ? `for ${t.lasted}` : n === data.timeline.length - 1 ? "now" : ""}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p class="empty-line">Nothing has happened yet: it hasn't been picked up.</p>
            )}
          </Section>
          {data.sections.length || data.answers ? (
            <Section
              title="The intent"
              aside={
                data.file ? (
                  <a href={data.file} target="_blank" rel="noopener noreferrer">
                    Open the file <External size={12} />
                  </a>
                ) : null
              }
            >
              <div class="card intent-text">
                {data.sections.map((s) => (
                  <div key={s.title} class="intent-section">
                    <h3>{s.title === "Towercab" ? "Towercab's note" : s.title}</h3>
                    <Markdown text={s.text} />
                  </div>
                ))}
                {data.answers ? (
                  <div class="intent-section">
                    <h3>Your answers</h3>
                    <Markdown text={data.answers} />
                  </div>
                ) : null}
              </div>
            </Section>
          ) : null}
        </div>
        <aside class="col-side">
          {data.times.steps.length ? (
            <Section title="Time per step">
              <div class="card pad">
                <ul class="steps">
                  {data.times.steps.map((s) => (
                    <li key={s.step} class={s.owner ? "owner" : undefined}>
                      <span class="step-name">{s.step}</span>
                      <span class="step-time num">{s.time}</span>
                      <svg class="step-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true">
                        <rect class="step-track" width="100" height="4" rx="2" />
                        <rect class="step-fill" width={Math.max(2, (s.secs / max) * 100)} height="4" rx="2" />
                      </svg>
                    </li>
                  ))}
                </ul>
                <dl class="steps-total">
                  <div>
                    <dt>Towercab working</dt>
                    <dd class="num">{data.times.towercab}</dd>
                  </div>
                  <div>
                    <dt>Waiting on you</dt>
                    <dd class="num">{data.times.owner}</dd>
                  </div>
                </dl>
              </div>
            </Section>
          ) : null}
          {data.attempts.length ? (
            <Section title="Cost">
              <div class="card pad">
                <ul class="attempts">
                  {data.attempts.map((a) => (
                    <li key={a.attempt}>
                      <span class="attempt-main">
                        <span class="attempt-name">Attempt {a.attempt}</span>
                        <StateChip state={a.state} small />
                      </span>
                      <span class="attempt-num">
                        <span class="num">{a.cost}</span>
                        <span class="meta">{a.agentTime} of work</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Section>
          ) : null}
          {data.runs.length ? (
            <Section title="Run files">
              <div class="card pad runs">
                {data.runs.map((g) => (
                  <div key={g.step} class="run-group">
                    <h3>{g.step}</h3>
                    <ul>
                      {g.files.map((f) => (
                        <li key={f.name}>
                          <a href={f.url} target="_blank" rel="noopener noreferrer" title={f.name}>
                            <FileText size={14} />
                            {f.label}
                          </a>
                          <span class="meta">{f.size}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
