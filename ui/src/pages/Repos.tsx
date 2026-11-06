// The Repos tab (UI-140 to UI-145): a chip per repo picks one (in the URL, `?repo=<name>`); its page shows
// what people can do with it, then what is in progress, up next, waiting and parked, then its spend.
// With no repo chosen, a short card per repo.

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type {
  ActionReply,
  ReposPage as Data,
  FeaturesView,
  FeatureView,
  QueueItem,
  RepoSpendView,
  RepoSummary,
  RepoView,
  SettingsView,
  SetupView,
} from "../../../src/ui/view.ts";
import { AddRepoForm } from "../AddRepo.tsx";
import { act, refreshFeatures } from "../api.ts";
import { ErrorNote, ProposedList, ReadinessChip, StateChip, Time, WorkRow } from "../components.tsx";
import { Alert, Check, External } from "../icons.tsx";
import { FileNotice, Limits } from "../Limits.tsx";
import { Link } from "../router.tsx";

const repoHref = (repo: string | null) => (repo ? `/repos?repo=${encodeURIComponent(repo)}` : "/repos");

function Chips({ data }: { data: Data }) {
  const total = data.chips.reduce((n, c) => n + c.open, 0);
  return (
    <nav class="repo-chips" aria-label="Repos">
      <Link
        href={repoHref(null)}
        class={data.selected === null ? "repo-chip on" : "repo-chip"}
        aria-current={data.selected === null ? "page" : undefined}
      >
        All <span class="num repo-chip-n">{total}</span>
      </Link>
      {data.chips.map((c) => (
        <Link
          key={c.repo}
          href={repoHref(c.repo)}
          class={data.selected === c.repo ? "repo-chip on" : "repo-chip"}
          aria-current={data.selected === c.repo ? "page" : undefined}
          title={`${c.open} open${c.needs ? `, ${c.needs} waiting on you` : ""}`}
        >
          {c.repo}
          <ReadinessChip badge={c.readiness} />
          <span class="num repo-chip-n">{c.open}</span>
          {c.needs ? <span class="repo-chip-needs" role="img" aria-label={`${c.needs} need you`} /> : null}
        </Link>
      ))}
    </nav>
  );
}

function Item({ item }: { item: QueueItem }) {
  return (
    <li class="q-item">
      {item.position !== null ? <span class="pos">{item.position}</span> : null}
      <div class="q-body">
        <Link class="q-title" href={`/i/${item.intent}`}>
          {item.title}
        </Link>
        {item.reason ? <span class="up-reason">{item.reason}</span> : null}
        {item.when || item.cost ? (
          <span class="meta">
            {item.when ? <Time when={item.when} /> : null}
            {item.when && item.cost ? " · " : ""}
            {item.cost ? <span class="num">{item.cost}</span> : null}
          </span>
        ) : null}
      </div>
      <StateChip state={item.state} small />
    </li>
  );
}

function FeatureList({ title, items, tone }: { title: string; items: FeatureView[]; tone: string }) {
  if (!items.length) return null;
  return (
    <div class="feat-group">
      <h3>
        {title} <span class="num meta">{items.length}</span>
      </h3>
      <ul class={`feat-list feat-${tone}`}>
        {items.map((f, n) => (
          <li key={`${f.intent ?? ""}:${n}`}>
            <span class="feat-mark" aria-hidden="true" />
            {f.intent ? <Link href={`/i/${f.intent}`}>{f.text}</Link> : <span>{f.text}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefreshButton({ repo }: { repo: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const go = async () => {
    setBusy(true);
    setResult(await refreshFeatures(repo));
    setBusy(false);
  };
  return (
    <>
      <button type="button" class="btn ghost small" disabled={busy} onClick={() => void go()}>
        {busy ? "Asking…" : "Refresh from the repo"}
      </button>
      {result ? (
        <p class={`result ${result.ok ? "ok" : "err"}`} role="status">
          {result.ok ? <Check size={16} /> : <Alert size={16} />}
          <span>{result.message}</span>
        </p>
      ) : null}
    </>
  );
}

/** REPO-32: the one step for a missing permission, with its button when the page can act. */
function SettingsStep({
  text,
  canGrant,
  action = "granted",
}: {
  text: string;
  canGrant: boolean;
  action?: string;
}) {
  const [result, setResult] = useState<ActionReply | null>(null);
  const grant = async () => setResult(await act(action));
  return (
    <>
      <p class="repo-step">
        <span>{text}</span>{" "}
        {canGrant ? (
          <button type="button" class="btn ghost small" onClick={() => void grant()}>
            Done
          </button>
        ) : null}
      </p>
      {result ? (
        <p class={`result ${result.ok ? "ok" : "err"}`} role="status">
          <span>{result.message}</span>
        </p>
      ) : null}
    </>
  );
}

function Settings({ s }: { s: SettingsView }) {
  return (
    <section class="card repo-settings" aria-labelledby="settings-h">
      <header class="repo-sec-head">
        <h2 id="settings-h">GitHub settings</h2>
        {s.at ? <span class="meta">checked {new Date(s.at * 1000).toLocaleString()}</span> : null}
      </header>
      <p class={s.state === "gaps" ? "" : "meta"}>{s.summary}</p>
      {s.gaps.length ? (
        <ul class="repo-gaps">
          {s.gaps.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      ) : null}
      {s.notes.map((n) => (
        <p class="meta" key={n}>
          {n}
        </p>
      ))}
      {s.step ? <SettingsStep text={s.step} canGrant={s.canGrant} /> : null}
    </section>
  );
}

function Features({ repo, f }: { repo: string; f: FeaturesView }) {
  const empty = !f.inProgress.length && !f.live.length && !f.planned.length;
  return (
    <section class="card repo-features" aria-labelledby="features-h">
      <header class="repo-sec-head">
        <h2 id="features-h">What people can do</h2>
        {f.url ? (
          <a class="meta repo-edit" href={f.url} target="_blank" rel="noreferrer">
            Edit the list <External size={12} />
          </a>
        ) : null}
      </header>
      {empty ? <p class="empty-line">No features listed yet.</p> : null}
      <FeatureList title="In progress" items={f.inProgress} tone="progress" />
      <FeatureList title="Live" items={f.live} tone="live" />
      <FeatureList title="Planned" items={f.planned} tone="planned" />
      {f.note || f.canRefresh ? (
        <footer class="repo-features-foot">
          {f.note ? <p class="meta">{f.note}</p> : null}
          {f.canRefresh ? <RefreshButton repo={repo} /> : null}
        </footer>
      ) : null}
    </section>
  );
}

function Group({ title, count, children }: { title: string; count?: number; children: ComponentChildren }) {
  return (
    <section class="repo-group" aria-label={title}>
      <h2>
        {title} {count === undefined ? null : <span class="num meta">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function SpendLine({ spend }: { spend: RepoSpendView }) {
  return (
    <ul class="repo-spend" aria-label="Spend">
      <li>
        <strong class="num">{spend.today}</strong> <span class="meta">today</span>
      </li>
      <li>
        <strong class="num">{spend.week}</strong> <span class="meta">7 days</span>
      </li>
      <li>
        <strong class="num">{spend.all}</strong> <span class="meta">all time</span>
      </li>
    </ul>
  );
}

/** UI-156: what the repo is missing, in words, above everything else. */
function SetupSection({ s }: { s: SetupView }) {
  return (
    <section class="card repo-setup" aria-label="Set up this repo">
      <h2>Set up this repo</h2>
      <ul class="setup-items">
        {s.items.map((i) => (
          <li key={i.item} class={`setup-item ${i.state}`}>
            <span class="setup-state">
              {i.state === "missing" ? "Missing" : i.state === "unknown" ? "Could not check" : "Waived"}
            </span>{" "}
            {i.words}
          </li>
        ))}
      </ul>
      <p>{s.sentence}</p>
      {s.hint.length ? (
        <p class="meta">
          To change that, add to <span class="mono">TOWERCAB.md</span>:{" "}
          {s.hint.map((h) => (
            <code key={h}>{h} </code>
          ))}
        </p>
      ) : null}
      {s.proposal ? (
        <p>
          Proposed setup, waiting for you to merge it:{" "}
          <a href={s.proposal.url} target="_blank" rel="noreferrer">
            {s.proposal.title}
          </a>
        </p>
      ) : null}
      {s.intent ? (
        <p>
          Setting it up: <Link href={`/i/${s.intent.id}`}>{s.intent.title}</Link>
        </p>
      ) : null}
    </section>
  );
}

function Repo({ r, readOnly }: { r: RepoView; readOnly: boolean }) {
  return (
    <div class="repo-page">
      <header class="repo-head">
        <h2 class="repo-name">{r.repo}</h2>
        <span class="meta">
          {r.github ? <span class="mono">{r.github} · </span> : null}
          {r.ahead}
        </span>
      </header>
      {r.limits.fileError ? <FileNotice text={r.limits.fileError} url={r.limits.fileUrl} /> : null}
      {r.setup ? <SetupSection s={r.setup} /> : null}
      {r.teammate ? (
        <section class="teammate-review">
          <p class="meta">
            Changes need a teammate's review:{" "}
            {r.teammate.reviewers.length ? r.teammate.reviewers.join(", ") : "the code owners"}
          </p>
          {r.teammate.warning ? (
            <p class="why review-warning" role="status">
              {r.teammate.warning}
            </p>
          ) : null}
        </section>
      ) : null}
      <Settings s={r.settings} />
      <Features repo={r.repo} f={r.features} />
      <Group title="In progress" count={r.inProgress.length}>
        {r.inProgress.length ? (
          <div class="rows compact">
            {r.inProgress.map((row) => (
              <WorkRow key={row.intent} row={row} />
            ))}
          </div>
        ) : (
          <p class="empty-line">Nothing is in progress.</p>
        )}
      </Group>
      <ProposedList data={r.proposed} readOnly={readOnly} />
      <Group title="Up next" count={r.upNext.length}>
        {r.upNext.length ? (
          <ol class="q-list">
            {r.upNext.map((i) => (
              <Item key={i.intent} item={i} />
            ))}
          </ol>
        ) : (
          <p class="empty-line">Nothing is queued.</p>
        )}
      </Group>
      {r.waiting.length ? (
        <Group title="Waiting" count={r.waiting.length}>
          <ul class="q-list">
            {r.waiting.map((i) => (
              <Item key={i.intent} item={i} />
            ))}
          </ul>
        </Group>
      ) : null}
      {r.parked.length ? (
        <details class="repo-group repo-parked">
          <summary>
            <h2>
              Parked <span class="num meta">{r.parked.length}</span>
            </h2>
            <span class="meta">Below the priority cutoff: raise urgency or importance to run them.</span>
          </summary>
          <ul class="q-list">
            {r.parked.map((i) => (
              <Item key={i.intent} item={i} />
            ))}
          </ul>
        </details>
      ) : null}
      {r.done.length ? (
        <details class="repo-group repo-parked">
          <summary>
            <h2>
              Recently done <span class="num meta">{r.done.length}</span>
            </h2>
            <span class="meta">The last ones done or dropped, newest first.</span>
          </summary>
          <ul class="q-list">
            {r.done.map((i) => (
              <Item key={i.intent} item={i} />
            ))}
          </ul>
        </details>
      ) : null}
      <Group title="Spend">
        <SpendLine spend={r.spend} />
      </Group>
      <Limits repo={r.repo} l={r.limits} />
    </div>
  );
}

function counts(s: RepoSummary): string {
  const parts = [
    `${s.inProgress} in progress`,
    s.needs ? `${s.needs} need${s.needs === 1 ? "s" : ""} you` : "",
    `${s.upNext} up next`,
    s.waiting ? `${s.waiting} waiting` : "",
    s.parked ? `${s.parked} parked` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function All({ data }: { data: Data }) {
  return (
    <div class="repo-all">
      {data.settingsStep ? (
        <section class="card repo-settings" aria-label="GitHub settings">
          <SettingsStep text={data.settingsStep.text} canGrant={data.settingsStep.canGrant} />
        </section>
      ) : null}
      {data.scanningStep ? (
        <section class="card repo-settings" aria-label="Code scanning alerts">
          <SettingsStep
            text={data.scanningStep.text}
            canGrant={data.scanningStep.canGrant}
            action="scanningGranted"
          />
        </section>
      ) : null}
      {data.all.map((s) => (
        <Link key={s.repo} class="card repo-card" href={repoHref(s.repo)}>
          <span class="repo-card-name">{s.repo}</span>
          <ReadinessChip badge={s.readiness} />
          {s.github ? <span class="meta mono">{s.github}</span> : null}
          {s.fileError ? <span class="why file-notice">{s.fileError}</span> : null}
          <span class="repo-card-counts">{counts(s)}</span>
          <span class="meta num">
            {s.spend.today} today · {s.spend.week} 7 days · {s.spend.all} all time
          </span>
        </Link>
      ))}
    </div>
  );
}

export function ReposPage({ data, readOnly }: { data: Data; readOnly: boolean }) {
  return (
    <main class="page repos" id="main">
      <section class="hero hero-small">
        <h1>Repos</h1>
        <p class="hero-sub">What each repo lets people do, and what Towercab is doing in it.</p>
      </section>
      <Chips data={data} />
      {data.error ? <ErrorNote text={data.error} /> : null}
      {data.chips.length === 0 ? (
        <p class="empty-line">No repos yet.{readOnly ? "" : " Add one below."}</p>
      ) : data.repo ? (
        <Repo r={data.repo} readOnly={readOnly} />
      ) : (
        <All data={data} />
      )}
      {/* UI-130, UI-142: the All view ends with the form that adds a repo. */}
      {readOnly || data.repo ? null : (
        <section class="card pad add-repo-card" aria-labelledby="add-repo-head">
          <h2 id="add-repo-head" class="repo-card-name">
            Add a repo
          </h2>
          <AddRepoForm />
        </section>
      )}
    </main>
  );
}
