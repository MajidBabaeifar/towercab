// What an intent's Telegram card says (TG-17, TG-18, TG-20, TG-21): a monospace block of characters, lines
// of at most 28 code points. Pure: no database, no network.

import { ownerOnlyLine } from "../autonomy.ts";

/** TG-18: the longest line inside the block, in code points. */
export const WIDTH = 28;
/** TG-20: the longest ping. */
export const PING_MAX = 60;
/** TG-17: the stages of the track, in order. */
export const TRACK = ["spec", "plan", "build", "review", "merge"] as const;

export type Mark = "●" | "◐" | "○";

/** One intent's card as the chat needs it (the loop's wiring fills it from `src/ui/`). */
export interface CardView {
  intent: string;
  /** The mission (attempt) the card belongs to; a restarted intent has a new one (TG-21). */
  mission: number;
  title: string;
  repo: string;
  /** The stages listed, each with its mark. */
  track: { name: string; mark: Mark }[];
  /** What is happening now, when nothing is asked of the owner. */
  status: string;
  /** TG-17: what the owner is asked, when the intent waits for them. */
  ask: string | null;
  /** A question or open point: it is answered by replying (TG-6). */
  question: boolean;
  /** AUT-32: an owner-only intent. */
  onlyYou: boolean;
  /** `<mission>.<continued>` while a wait stands (TG-5), else null. */
  waitId: string | null;
  /** TG-21: the final line (`✅ done`, `⚠ unverified: …`, `🗑 dropped`) once the intent has ended. */
  final: string | null;
  /** TG-14: the link under the block, or null. */
  link: string | null;
}

const chars = (s: string): string[] => [...s];
const len = (s: string): number => chars(s).length;

/** Cut to `max` code points, ending in `…` when something was cut. */
export function clip(s: string, max: number): string {
  const c = chars(s);
  return c.length > max ? `${c.slice(0, max - 1).join("")}…` : s;
}

/** TG-18: break at word breaks into lines of at most `width` code points; a longer word is cut with `…`. */
export function wrap(text: string, width = WIDTH): string[] {
  const lines: string[] = [];
  let line = "";
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    const word = clip(raw, width);
    if (line && len(line) + 1 + len(word) <= width) line += ` ${word}`;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** At most `max` lines; when more, the last one ends with `…`. */
function limit(lines: string[], max: number, width = WIDTH): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = clip(`${kept[max - 1]!} …`, width);
  return kept;
}

/** TG-17, TG-18: `spec ● plan ● build ◐ review ○ merge ○`, split between stages when it does not fit. */
export function trackLines(track: CardView["track"], width = WIDTH): string[] {
  const lines: string[] = [];
  let line = "";
  for (const t of track) {
    const item = `${t.name} ${t.mark}`;
    if (line && len(line) + 1 + len(item) <= width) line += ` ${item}`;
    else {
      if (line) lines.push(line);
      line = item;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const esc = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** TG-17: the lines inside the block, in order: id, title, repo, status, track. */
export function cardLines(v: CardView): string[] {
  const status: string[] = [];
  if (v.final) status.push(...wrap(v.final));
  else if (v.ask !== null) {
    status.push(...wrap(`▶ YOU: ${v.ask}`));
    if (v.question) status.push(...wrap("Reply to answer."));
    if (v.onlyYou) status.push(...wrap(ownerOnlyLine(v.intent)));
  } else status.push(...wrap(v.status));
  return [
    clip(`◆ ${v.intent}`, WIDTH),
    ...limit(wrap(v.title), 2),
    clip(v.repo, WIDTH),
    ...status,
    ...trackLines(v.track),
  ];
}

/** TG-17: the card as HTML: the block, then the link outside it. */
export function cardText(v: CardView): string {
  const block = `<pre>${esc(cardLines(v).join("\n"))}</pre>`;
  return v.link ? `${block}\n${esc(v.link)}` : block;
}

/** TG-20: one plain line, `<short title>: <ask>`. */
export function pingText(v: Pick<CardView, "title" | "ask">): string {
  const ask = (v.ask ?? "").replace(/\s+/g, " ").trim();
  const title = clip(v.title.replace(/\s+/g, " ").trim(), 24);
  return clip(`${title}: ${ask}`, PING_MAX);
}

/** TG-17: the track's position for a stage, or -1 when the stage is not on the track (`pick`, `done`). */
export function trackIndex(stage: string, from: string | null): number {
  switch (stage) {
    case "design":
    case "approval:spec":
      return 0;
    case "plan":
    case "approval:plan":
      return 1;
    case "build":
    case "verify":
    case "proof":
    case "publish":
    case "ci":
      return 2;
    case "review":
    case "gate":
    case "approval:merge":
      return 3;
    case "merge":
    case "steps":
    case "deploy":
    case "e2e":
    case "rollback":
    case "revert":
      return 4;
    case "blocked":
      return from && from !== "blocked" ? trackIndex(from, null) : -1;
    default:
      return -1;
  }
}

/**
 * TG-17: the marks. `first` is the earliest stage the intent visited (earlier ones are skipped and not
 * listed); `at` the current one; `all` marks every stage done.
 */
export function buildTrack(at: number, first: number, all: boolean): CardView["track"] {
  const cur = Math.max(at, 0);
  const out: CardView["track"] = [];
  TRACK.forEach((name, i) => {
    if (i < Math.max(first, 0)) return;
    out.push({ name, mark: all || i < cur ? "●" : i === cur && at >= 0 ? "◐" : "○" });
  });
  return out;
}
