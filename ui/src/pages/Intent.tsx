// One intent's whole story (UI-62): state, the three PRs, the stage map with its logs (UI-73 to UI-77),
// the folded list of moves, cost and the intent's own text.

import type { IntentPage as Data, PrView } from "../../../src/ui/view.ts";
import { AutonomyControl } from "../AutonomyControl.tsx";
import {
  Details,
  Id,
  NeedsCard,
  OnlyYou,
  PauseButton,
  RiskBlock,
  Section,
  ShadowTag,
  StartButton,
  StateChip,
  StepsChecklist,
  Time,
} from "../components.tsx";
import { ChevronLeft, External, PullRequest } from "../icons.tsx";
import { Markdown } from "../md.tsx";
import { Link } from "../router.tsx";
import { ControlNotes, ScoreControl } from "../ScoreControls.tsx";
import { StageMap } from "../StageMap.tsx";

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

/** UI-160: the owner's steps as a checklist; ticking one posts the step action. */
function StepsBlock({ data, readOnly }: { data: Data; readOnly: boolean }) {
  return (
    <section class={`card pad steps-block${data.stepsWait ? " waiting" : ""}`} aria-label="Your steps">
      <p class="access-head">Your steps</p>
      <StepsChecklist intent={data.id} steps={data.steps ?? []} readOnly={readOnly} />
    </section>
  );
}

export function IntentPage({ data, readOnly }: { data: Data; readOnly: boolean }) {
  const moves = (
    <details class="moves">
      <summary>
        All moves <span class="count">{data.timeline.length}</span>
      </summary>
      {data.timeline.length ? (
        <ol class="timeline">
          {data.timeline.map((t, n) => (
            <li key={n} class={`tl tl-${t.tone}`}>
              <span class="tl-time">
                <Time when={t.at} short />
              </span>
              <span class="tl-dot" aria-hidden="true" />
              <div class="tl-body">
                <p class={`tl-text${t.shadow ? " tl-shadow" : ""}`}>{t.text}</p>
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
    </details>
  );
  return (
    <main class="page intent" id="main">
      <Link class="back" href="/overview">
        <ChevronLeft size={16} />
        Overview
      </Link>
      <header class="intent-head">
        <div class="intent-title">
          <h1>
            {data.title} {data.onlyYou ? <OnlyYou /> : null}
            {data.shadow ? <ShadowTag /> : null}
          </h1>
          <p class="meta">
            {data.repo} · <Id id={data.id} />
            {data.scores ? ` · ${data.scores}` : ""}
            {data.issue ? (
              <>
                {" · "}
                <a href={data.issue} target="_blank" rel="noopener noreferrer">
                  GitHub issue <External size={12} />
                </a>
              </>
            ) : null}
            {data.e2eLog ? (
              <>
                {" · "}
                <a href={data.e2eLog} target="_blank" rel="noopener noreferrer">
                  e2e log <External size={12} />
                </a>
              </>
            ) : null}
          </p>
        </div>
        <StateChip state={data.state} />
      </header>
      <p class="sentence">{data.sentence}</p>
      {data.onlyYou ? <p class="meta only-you-line">{data.onlyYou}</p> : null}
      {data.autonomy ? <AutonomyControl intent={data.id} view={data.autonomy} readOnly={readOnly} /> : null}
      {data.controls ? <ScoreControl intent={data.id} view={data.controls} readOnly={readOnly} /> : null}
      {data.controls ? <ControlNotes view={data.controls} /> : null}
      {!readOnly && (data.onlyYou || data.paused) ? (
        <PauseButton intent={data.id} paused={data.paused === true} />
      ) : null}
      {data.canStart ? <StartButton intent={data.id} /> : null}
      <section class="prs" aria-label="Pull requests">
        {data.prs.map((p) => (
          <PrTile key={p.label} pr={p} />
        ))}
      </section>
      {data.agent_comments.length ? (
        <section class="card pad agent-comments" aria-label="Written in your name by agents">
          <p class="access-head">Written in your name by agents</p>
          <ul>
            {data.agent_comments.map((c, n) => (
              <li key={n}>
                <span class="chip">agent, for you</span> <strong>{c.agent}</strong>
                {" · "}
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noopener noreferrer">
                    comment <External size={12} />
                  </a>
                ) : (
                  "comment"
                )}
                {" · "}
                <Time when={c.at} short />
                {c.acted_on ? "" : " · ignored: this intent is only yours"}
                <p class="meta">{c.excerpt}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.card ? (
        <NeedsCard card={data.card} readOnly={readOnly} linkTitle={false} showSteps={false} />
      ) : null}
      {data.steps?.length ? <StepsBlock data={data} readOnly={readOnly} /> : null}
      {data.nothingLive ? <p class="meta">Nothing to check live: {data.nothingLive}</p> : null}
      {data.release ? (
        <p class="meta">
          {data.release.url ? (
            <a href={data.release.url} target="_blank" rel="noopener noreferrer">
              {data.release.text} <External size={12} />
            </a>
          ) : (
            data.release.text
          )}
        </p>
      ) : null}
      {data.brief ? (
        <section class="card pad plain-brief" aria-label="For people">
          <p class="access-head">For people</p>
          <Markdown text={data.brief} />
          {data.details ? <Details id={`page:${data.id}`} text={data.details} /> : null}
        </section>
      ) : null}
      {data.tests?.length ? (
        <section class="card pad access" aria-label="Existing tests changed">
          <p class="access-head">Existing tests changed</p>
          <ul>
            {data.tests.map((t) => (
              <li key={t.path}>
                <span class="mono">{t.path}</span>
                <span class="access-why">
                  {t.why}
                  {t.by === "refused"
                    ? " (refused: it stays as it is)"
                    : t.by === "plan"
                      ? " (allowed by the approved plan)"
                      : " (allowed by you)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.risk ? <RiskBlock risk={data.risk} /> : null}
      <Section title="How it went" class="path">
        {data.attempts.length ? <StageMap id={data.id} attempts={data.attempts} moves={moves} /> : moves}
      </Section>
      <div class="cols">
        <div class="col-main">
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
        </aside>
      </div>
    </main>
  );
}
