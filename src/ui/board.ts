// The board (UI-133 to UI-137): every intent as a card, one column per airspace station and one row per
// repo. Cards take their column from the airspace's planes, so the two never disagree.

import type { Intent } from "../intents/types.ts";
import { repoSpendView, spendByRepo, spendTotals } from "./spend.ts";
import { ago, airspaceOf, dbMark, snapshot, state, type UiSources, versionOf } from "./state.ts";
import type { BoardCard, BoardColumn, BoardColumnKey, BoardPage, BoardRepo } from "./view.ts";

const WEEK = 7 * 86_400;

const COLUMNS: { key: BoardColumnKey; label: string }[] = [
  { key: "queue", label: "Queue" },
  { key: "gate", label: "Gate" },
  { key: "spec", label: "Spec" },
  { key: "spec-review", label: "Your spec review" },
  { key: "plan", label: "Plan" },
  { key: "plan-review", label: "Your plan review" },
  { key: "code", label: "Code" },
  { key: "ci", label: "CI" },
  { key: "code-review", label: "Your code review" },
  { key: "deploy", label: "Deploy" },
  { key: "e2e", label: "e2e" },
  { key: "done", label: "Done" },
];

/** The board's data (`GET /api/board`). */
export async function board(src: UiSources): Promise<BoardPage> {
  const s = await snapshot(src);
  const withMission = new Set(s.missions.map((m) => m.intent));
  const list = src.upNext().filter((u) => !withMission.has(u.intent));
  const air = airspaceOf(src, s, list, 0);

  const repos: string[] = [...src.config.repos.keys()];
  const cells = new Map<string, Partial<Record<BoardColumnKey, BoardCard[]>>>();
  const counts = new Map<string, { open: number; done: number }>();
  const put = (repo: string, key: BoardColumnKey, card: BoardCard, done: boolean) => {
    if (!repo) return;
    if (!repos.includes(repo)) repos.push(repo);
    let row = cells.get(repo);
    if (!row) {
      row = {};
      cells.set(repo, row);
    }
    let c = counts.get(repo);
    if (!c) {
      c = { open: 0, done: 0 };
      counts.set(repo, c);
    }
    if (done) c.done++;
    else c.open++;
    const list = row[key] ?? [];
    list.push(card);
    row[key] = list;
  };

  // Parked planes come first on the line; on the board they sit in Queue below the queued ones.
  const planes = [
    ...air.planes.filter((p) => p.station !== "parked"),
    ...air.planes.filter((p) => p.station === "parked"),
  ];
  for (const p of planes) {
    if (p.station === "landed") continue;
    const key: BoardColumnKey = p.station === "parked" ? "queue" : p.station;
    put(
      p.repo,
      key,
      { intent: p.intent, title: p.title, state: p.state, ...(p.ship ? { ship: p.ship } : {}) },
      false,
    );
  }

  const dropped = s.listing?.droppedIds ?? new Set<string>();
  const finishedAt = (i: Intent) => (i.finished ? Date.parse(i.finished) / 1000 : Number.NaN);
  const done = (s.listing?.done ?? [])
    .filter((i) => i.stage === "done" && !dropped.has(i.id))
    .filter((i) => {
      const at = finishedAt(i);
      return Number.isFinite(at) && at > s.now - WEEK && at <= s.now;
    })
    .sort((a, b) => finishedAt(b) - finishedAt(a));
  for (const i of done) {
    put(
      i.repo,
      "done",
      { intent: i.id, title: i.title, state: state("done", ago(finishedAt(i), s.now)) },
      true,
    );
  }

  const shown = COLUMNS.filter((c) => air.ship || (c.key !== "deploy" && c.key !== "e2e"));
  const spend = spendByRepo(src.db, s.now);
  const rows: BoardRepo[] = repos.map((repo) => ({
    repo,
    github: src.config.repos.get(repo)?.github ?? "",
    open: counts.get(repo)?.open ?? 0,
    done: counts.get(repo)?.done ?? 0,
    spend: repoSpendView(spend.get(repo)),
    cells: cells.get(repo) ?? {},
  }));
  const columns: BoardColumn[] = shown.map((c) => ({
    ...c,
    count: rows.reduce((n, r) => n + (r.cells[c.key]?.length ?? 0), 0),
  }));
  const body = { columns, repos: rows, spend: repoSpendView(spendTotals(spend)) };
  return { version: versionOf(body, dbMark(src.db)), ...body };
}
