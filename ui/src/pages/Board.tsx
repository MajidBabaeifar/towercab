// The board (UI-133 to UI-137): one column per airspace station, one row per repo; each row folds, and
// the folded rows are remembered in this browser. At 720 px wide or less it is one list per repo instead.

import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import type {
  BoardCard,
  BoardColumn,
  BoardRepo,
  BoardPage as Data,
  RepoSpendView,
} from "../../../src/ui/view.ts";
import { readSort, SORTS, type SortKey, sortLabel, sortRepos, writeSort } from "../board-sort.ts";
import { ErrorNote, ReadinessChip, StateChip } from "../components.tsx";
import { ChevronDown } from "../icons.tsx";
import { Link } from "../router.tsx";

const KEY = "towercab.board.folded";

function readFolded(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeFolded(folded: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...folded]));
  } catch {
    // No storage: the row stays folded until the page reloads.
  }
}

function SpendLine({ spend }: { spend: RepoSpendView }) {
  return (
    <span class="board-spend num" title="What Towercab spent on this repo">
      {spend.today} today · {spend.week} 7 days · {spend.all} all time
    </span>
  );
}

function Card({ card }: { card: BoardCard }) {
  return (
    <li>
      <Link class="board-card" href={`/i/${card.intent}`}>
        <span class="board-card-title">{card.title}</span>
        <span class="board-card-foot">
          {/* The note goes beside the chip, so a narrow card wraps it instead of cutting it. */}
          <StateChip state={{ ...card.state, note: null }} small />
          {card.state.note ? <span class="meta">{card.state.note}</span> : null}
          {card.ship ? <span class={`board-ship board-ship-${card.ship.kind}`}>{card.ship.mark}</span> : null}
        </span>
      </Link>
    </li>
  );
}

/** The lane of intents the listing doesn't know has no repo name. */
const repoName = (repo: string) => repo || "Unknown repo";

function LaneHead({ repo, folded, onToggle }: { repo: BoardRepo; folded: boolean; onToggle(): void }) {
  return (
    <div class="board-lane-inner">
      <h2>
        <button
          type="button"
          class="board-toggle"
          aria-expanded={!folded}
          title={folded ? `Show ${repoName(repo.repo)}` : `Fold ${repoName(repo.repo)}`}
          onClick={onToggle}
        >
          <ChevronDown size={16} class="board-chev" />
          <span>{repoName(repo.repo)}</span>
        </button>
      </h2>
      {repo.readiness ? (
        <Link href={`/repos?repo=${encodeURIComponent(repo.repo)}`} class="ready-link">
          <ReadinessChip badge={repo.readiness} />
        </Link>
      ) : null}
      {repo.fileError ? <span class="why file-notice">{repo.fileError}</span> : null}
      <span class="meta">
        {repo.github ? <span class="mono">{repo.github} · </span> : null}
        {repo.open} open · {repo.done} done in the last 7 days
        {repo.proposed ? ` · ${repo.proposed} proposed` : ""}
      </span>
      <SpendLine spend={repo.spend} />
    </div>
  );
}

// Narrow enough that ten columns, three of them empty, fit a 1280 px screen.
const FULL = 144;
const NARROW = 64;

const EMPTY_LANE = "Nothing open, and nothing done in the last 7 days.";

/** Desktop: one grid, column headers stuck to its top, repo headers to its left. */
function Grid({ data, folded, toggle }: { data: Data; folded: Set<string>; toggle(repo: string): void }) {
  // Columns with cards share the room left over; the grid is never narrower than their minimum.
  const full = data.columns.filter((c) => c.count).length;
  const template = data.columns.map((c) => (c.count ? `minmax(${FULL}px, 1fr)` : `${NARROW}px`)).join(" ");
  const style = {
    gridTemplateColumns: template,
    width: `${full * FULL + (data.columns.length - full) * NARROW}px`,
  } as JSX.CSSProperties;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the board scrolls sideways; keyboard users scroll it too.
    <section class="board" tabIndex={0} aria-label="Board by repo and station">
      <div class="board-grid" style={style}>
        {data.columns.map((c) => (
          <div key={c.key} class={`board-col-head${c.count ? "" : " narrow"}`}>
            <span class="board-col-label">{c.label}</span>
            <span class="board-col-count num">{c.count}</span>
          </div>
        ))}
        {data.repos.map((r) => {
          const isFolded = folded.has(r.repo);
          const any = r.open + r.done > 0;
          return [
            <div key={`${r.repo}:head`} class={`board-lane-head${isFolded ? " folded" : ""}`}>
              <LaneHead repo={r} folded={isFolded} onToggle={() => toggle(r.repo)} />
            </div>,
            ...(isFolded
              ? []
              : any
                ? data.columns.map((c) => <Cell key={`${r.repo}:${c.key}`} repo={r} column={c} />)
                : [
                    <p key={`${r.repo}:empty`} class="board-lane-empty">
                      <span class="empty-line">{EMPTY_LANE}</span>
                    </p>,
                  ]),
          ];
        })}
      </div>
    </section>
  );
}

function Cell({ repo, column }: { repo: BoardRepo; column: BoardColumn }) {
  const cards = repo.cells[column.key] ?? [];
  return (
    <ul
      class={`board-cell${column.count ? "" : " narrow"}`}
      aria-label={`${repoName(repo.repo)}, ${column.label}`}
    >
      {cards.map((c) => (
        <Card key={c.intent} card={c} />
      ))}
    </ul>
  );
}

/** Phone: a section per repo, its cards listed under the station names. */
function List({ data, folded, toggle }: { data: Data; folded: Set<string>; toggle(repo: string): void }) {
  return (
    <div class="board-list">
      {data.repos.map((r) => {
        const isFolded = folded.has(r.repo);
        const columns = data.columns.filter((c) => r.cells[c.key]?.length);
        return (
          <section key={r.repo} class="card board-section" aria-label={`Repo ${repoName(r.repo)}`}>
            <LaneHead repo={r} folded={isFolded} onToggle={() => toggle(r.repo)} />
            {isFolded ? null : columns.length ? (
              columns.map((c) => (
                <div key={c.key} class="board-station">
                  <h3>{c.label}</h3>
                  <ul class="board-cell" aria-label={`${repoName(r.repo)}, ${c.label}`}>
                    {(r.cells[c.key] ?? []).map((card) => (
                      <Card key={card.intent} card={card} />
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <p class="empty-line">{EMPTY_LANE}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function BoardPage({ data }: { data: Data }) {
  const [folded, setFolded] = useState<Set<string>>(readFolded);
  const toggle = (repo: string) => {
    const next = new Set(folded);
    if (next.has(repo)) next.delete(repo);
    else next.add(repo);
    writeFolded(next);
    setFolded(next);
  };
  const [sort, setSort] = useState<SortKey>(readSort);
  const [announce, setAnnounce] = useState("");
  const choose = (key: SortKey) => {
    writeSort(key);
    setSort(key);
    setAnnounce(`Sorted by ${sortLabel(key)}`);
  };
  const sorted = useMemo(() => ({ ...data, repos: sortRepos(data.repos, sort) }), [data, sort]);
  return (
    <main class="page board-page" id="main">
      <section class="hero hero-small">
        <h1>Board</h1>
        <p class="hero-sub">
          Every intent at its station, one row per repo.
          {data.proposed ? (
            <>
              {" "}
              <Link href="/">{data.proposed} proposed</Link>
            </>
          ) : null}
        </p>
        <p class="board-total">
          Spent <SpendLine spend={data.spend} />
        </p>
      </section>
      {data.error ? <ErrorNote text={data.error} /> : null}
      {data.repos.length === 0 ? (
        data.error ? null : (
          <p class="empty-line">No repos in the config yet.</p>
        )
      ) : data.error && data.repos.every((r) => r.open + r.done === 0) ? null : (
        <>
          <div class="board-sort">
            <label for="board-sort">Sort by</label>
            <select
              id="board-sort"
              value={sort}
              onChange={(e) => choose((e.currentTarget as HTMLSelectElement).value as SortKey)}
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <p class="sr-only" role="status" aria-live="polite">
              {announce}
            </p>
          </div>
          <Grid data={sorted} folded={folded} toggle={toggle} />
          <List data={sorted} folded={folded} toggle={toggle} />
        </>
      )}
    </main>
  );
}
