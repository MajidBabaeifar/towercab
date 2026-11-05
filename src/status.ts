// `towercab status` (LOOP-13): what is happening, in plain lines, with or without a running loop.

import type { Db } from "./db.ts";
import type { Listing } from "./intents/types.ts";
import { isWait, isWorking, waitInfo } from "./machine.ts";
import { dataOf, type Mission, unfinished } from "./mission.ts";
import { missing, parseStored } from "./repo/readiness.ts";
import { buildingIn, capOf, idleIn, returningIn, returningSince, workingIn } from "./slots.ts";
import { leftOf, type OwnerStep } from "./steps.ts";

export interface Problem {
  kind: string;
  since: number;
  error: string;
}

export interface StatusInput {
  db: Db;
  listing: Listing | null;
  listingError: string | null;
  running: number | null;
  version: string;
  now: number;
  problems: Problem[];
  /** The first line of `next`. */
  next: string;
  /** Intents the picker skipped because their repo has its `ahead` intents (LOOP-64), as `next` words them. */
  waits?: string[];
  prLink(m: Mission): string | null;
  queued: Set<number>;
  /** A repo's `workers` (LOOP-110); 1 when absent. */
  workers?: (repo: string) => number;
}

const STEP: Record<string, string> = {
  pick: "getting the repo ready",
  design: "writing the spec",
  plan: "planning",
  build: "building",
  verify: "running checks",
  proof: "proving the tests",
  publish: "opening the PR",
  ci: "waiting for CI",
  review: "reviewing",
  gate: "deciding the merge",
  merge: "merging",
};

export function time(unix: number, now: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now * 1000).toDateString() === d.toDateString()
    ? hm
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function renderStatus(s: StatusInput): string {
  const title = (m: Mission) => {
    const i =
      s.listing?.open.find((x) => x.id === m.intent) ?? s.listing?.done.find((x) => x.id === m.intent);
    return `${m.intent} ${m.repo}: ${i?.title ?? "(title unknown)"}`;
  };
  const head = [
    `towercab ${s.version} · ${s.running ? `running (pid ${s.running})` : "not running"}`,
    s.db.meta("paused") === "1" ? "paused" : "",
    s.running && s.db.meta("draining") ? `draining for update to ${s.db.meta("draining")}` : "",
    s.problems.length ? "problems" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [head];
  const ms = unfinished(s.db);
  // LOOP-74: `steps` is a working stage that waits on the owner.
  const onSteps = (m: Mission) => m.stage === "steps" && m.waiting !== null;
  const returning = (m: Mission) => returningSince(m) !== null;
  const working = ms.filter(
    (m) => isWorking(m.stage) && !s.queued.has(m.id) && m.stage !== "ci" && !onSteps(m) && !returning(m),
  );
  lines.push(working.length ? "working:" : "working: nothing");
  for (const m of working) {
    const model = m.child_model ? ` · ${m.child_model}` : "";
    lines.push(`- ${title(m)} · ${STEP[m.stage] ?? m.stage}${model} · since ${time(m.updated, s.now)}`);
  }
  const onMe = ms.filter((m) => (isWait(m.stage) || onSteps(m)) && !s.queued.has(m.id));
  if (onMe.length) {
    lines.push("waiting on you:");
    for (const m of onMe) {
      const link = s.prLink(m);
      // UI-163: how many of the owner's steps are left.
      const left = leftOf(dataOf<{ steps?: OwnerStep[] }>(m).steps, m.waiting);
      lines.push(
        `- ${title(m)} · ${waitInfo(m.waiting ?? "answer the question").ask}${left ? ` (${left} left)` : ""}${link ? ` ${link}` : ""}`,
      );
    }
  }
  const ci = ms.filter((m) => m.stage === "ci" && !returning(m));
  if (ci.length) {
    lines.push("waiting on CI:");
    for (const m of ci) lines.push(`- ${title(m)} · since ${time(m.updated, s.now)}`);
  }
  // LOOP-110..112: the build slots of each repo, and what holds a ready or returning mission back.
  const workersOf = (repo: string) => s.workers?.(repo) ?? 1;
  const queued = ms.filter((m) => s.queued.has(m.id));
  const back = ms.filter(returning);
  if (queued.length || back.length) {
    lines.push("queued:");
    for (const m of queued) {
      const w = workersOf(m.repo);
      const building = buildingIn(ms, m.repo);
      if (building.length >= capOf(w)) {
        const idle = idleIn(ms, m.repo).length;
        lines.push(
          `- ${title(m)} · waiting: repo is at the cap of ${capOf(w)} missions between build and merge, ${building.length - idle} working and ${idle} waiting`,
        );
        continue;
      }
      const holder = workingIn(ms, m.repo)[0] ?? returningIn(ms, m.repo, s.listing)[0];
      lines.push(`- ${title(m)} · ready to build${holder ? `, behind ${holder.intent}` : ""}`);
    }
    for (const m of back) {
      const line = returningIn(ms, m.repo, s.listing);
      const holder = workingIn(ms, m.repo)[0] ?? line[line.findIndex((x) => x.id === m.id) - 1];
      lines.push(`- ${title(m)} · waiting for a build slot${holder ? `, behind ${holder.intent}` : ""}`);
    }
  }
  for (const repo of [...new Set(ms.map((m) => m.repo))]) {
    const building = buildingIn(ms, repo);
    if (building.length === 0) continue;
    const w = workersOf(repo);
    const idle = idleIn(ms, repo).length;
    lines.push(
      `build slots: ${repo} ${building.length - idle} of ${w} used, ${idle} waiting outside slots (cap ${capOf(w)})`,
    );
  }
  for (const w of s.waits ?? []) lines.push(`waiting: ${w}`);
  // LOOP-72: a repo missing setup, and whether that holds its new work back.
  for (const { key, value } of s.db.all<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key LIKE 'readiness:%' ORDER BY key",
  )) {
    const r = parseStored(value)?.readiness;
    if (!r || r.ready) continue;
    const n = missing(r).length;
    lines.push(
      `not ready: ${key.slice(10)} · ${n} missing · ${r.blocks ? "new work waits" : "warning only"}`,
    );
  }
  for (const row of s.db.all<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key LIKE 'cooldown:%'",
  )) {
    try {
      const until = (JSON.parse(row.value) as { until: number }).until;
      if (until > s.now) lines.push(`cooling down: ${row.key.slice(9)} until ${time(until, s.now)}`);
    } catch {
      // A bad row is ignored.
    }
  }
  for (const p of s.problems) lines.push(`problem: ${p.kind}: ${p.error} · since ${time(p.since, s.now)}`);
  if (s.listingError) lines.push(`intents: ${s.listingError}`);
  for (const u of s.listing?.unreadable ?? []) lines.push(`can't read: ${u.path}: ${u.reason}`);
  lines.push(s.next);
  return `${lines.join("\n")}\n`;
}
