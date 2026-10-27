// `towercab status` (LOOP-13): what is happening, in plain lines, with or without a running loop.

import type { Db } from "./db.ts";
import type { Listing } from "./intents/types.ts";
import { isWait, isWorking, waitInfo } from "./machine.ts";
import { type Mission, unfinished } from "./mission.ts";

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
  prLink(m: Mission): string | null;
  queued: Set<number>;
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
    s.problems.length ? "problems" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [head];
  const ms = unfinished(s.db);
  const working = ms.filter((m) => isWorking(m.stage) && !s.queued.has(m.id) && m.stage !== "ci");
  lines.push(working.length ? "working:" : "working: nothing");
  for (const m of working) {
    const model = m.child_model ? ` · ${m.child_model}` : "";
    lines.push(`- ${title(m)} · ${STEP[m.stage] ?? m.stage}${model} · since ${time(m.updated, s.now)}`);
  }
  const onMe = ms.filter((m) => isWait(m.stage));
  if (onMe.length) {
    lines.push("waiting on you:");
    for (const m of onMe) {
      const link = s.prLink(m);
      lines.push(
        `- ${title(m)} · ${waitInfo(m.waiting ?? "answer the question").ask}${link ? ` ${link}` : ""}`,
      );
    }
  }
  const ci = ms.filter((m) => m.stage === "ci");
  if (ci.length) {
    lines.push("waiting on CI:");
    for (const m of ci) lines.push(`- ${title(m)} · since ${time(m.updated, s.now)}`);
  }
  const queued = ms.filter((m) => s.queued.has(m.id));
  if (queued.length) {
    lines.push("queued:");
    for (const m of queued) lines.push(`- ${title(m)} · behind another intent in ${m.repo}`);
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
