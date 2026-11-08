// What a Telegram message says and which buttons it carries (TG-3, TG-4, TG-11, TG-13, TG-14). Pure: no
// database, no network.

import { ownerOnlyLine } from "../autonomy.ts";
import type { Config } from "../config.ts";
import type { Button } from "../outbox.ts";

/** One wait on the owner, as the messages need it. */
export interface WaitView {
  intent: string;
  title: string;
  repo: string;
  /** What the owner decides, in plain words. */
  ask: string;
  why: string | null;
  /** A question or open point: it is answered by replying (TG-6). */
  question: boolean;
  /** The buttons the card offers (TG-3). */
  actions: ("merge" | "retry" | "drop")[];
  /** AUT-32: an owner-only intent gets no buttons. */
  onlyYou: boolean;
  /** `<mission>.<continued>`: a new wait on the same intent has a new id (TG-5). */
  waitId: string;
  /** The PR head the message shows; the merge confirm checks it (TG-4). */
  head: string;
  pr: { number: number; url: string; label: string } | null;
  /** The branch a merge lands on. */
  base: string;
}

/** A proposed intent (UI-185): accept or close its PR. */
export interface ProposalView {
  pr: number;
  head: string;
  title: string;
  repo: string;
  url: string;
}

/** TG-13: at most this many characters outside the link. */
export const MAX_BODY = 600;
/** Telegram's limit for `callback_data`, in bytes. */
export const MAX_DATA = 64;
/** The line that marks a message as a question (TG-6). */
export const REPLY_LINE = "Reply to this message to answer.";

const oneLine = (s: string, max: number): string => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

export const firstLine = (s: string): string => s.split("\n")[0] ?? "";

/** TG-14: the card's address, else the PR's, else none. */
export function cardLink(tg: Config["telegram"], intent: string, prUrl: string | null): string | null {
  if (tg?.uiUrl) return `${tg.uiUrl.replace(/\/+$/, "")}/?intent=${encodeURIComponent(intent)}`;
  return prUrl;
}

/** `callback_data`: `<op>|<a>|<b>[|<c>]`. */
export function encode(op: string, a: string, b: string, c = ""): string | null {
  const data = [op, a, b, ...(c ? [c] : [])].join("|");
  return Buffer.byteLength(data) <= MAX_DATA ? data : null;
}

export function decode(data: string): { op: string; a: string; b: string; c: string } | null {
  const [op, a, b, c] = data.split("|");
  return op && a !== undefined && b !== undefined ? { op, a, b, c: c ?? "" } : null;
}

const button = (text: string, data: string | null): Button[] => (data ? [{ text, data }] : []);

/** TG-3: the card's buttons; a question only has Drop, an owner-only intent none. */
export function waitButtons(v: WaitView): Button[][] {
  if (v.onlyYou) return [];
  const head = v.head.slice(0, 7);
  const row: Button[] = [];
  for (const a of v.question ? v.actions.filter((x) => x === "drop") : v.actions) {
    if (a === "merge")
      row.push(...button("Merge", encode("m", v.intent, v.waitId, head) ?? encode("m", v.intent, v.waitId)));
    if (a === "retry") row.push(...button("Start over", encode("r", v.intent, v.waitId)));
    if (a === "drop") row.push(...button("Drop", encode("d", v.intent, v.waitId)));
  }
  return row.length ? [row] : [];
}

/** TG-4: the second press. `Cancel` restores the message. */
export function confirmButtons(op: "M" | "D", v: WaitView): Button[][] {
  const head = op === "M" ? v.head.slice(0, 7) : "";
  const yes = encode(op, v.intent, v.waitId, head) ?? encode(op, v.intent, v.waitId);
  return [
    [
      ...button(op === "M" ? "Yes, merge" : "Yes, drop", yes),
      ...button("Cancel", encode("x", v.intent, v.waitId)),
    ],
  ];
}

export function confirmText(op: "M" | "D", v: WaitView): string {
  if (op === "D") return `Drop ${oneLine(v.title, 80)}? This closes its PR.`;
  const pr = v.pr ? `the ${v.pr.label} #${v.pr.number} of ` : "";
  return `Merge ${pr}${oneLine(v.title, 80)} into ${v.base}?`;
}

/** TG-3: Accept and Close for a proposed intent; the head is its version (UI-185). */
export function proposalButtons(p: ProposalView): Button[][] {
  const accept = encode("a", String(p.pr), p.head);
  const close = encode("c", String(p.pr), p.head);
  return accept && close ? [[...button("Accept", accept), ...button("Close", close)]] : [];
}

/** TG-13: ask, then what and where, then why; no IDs, short, with the link last. */
export function waitText(v: WaitView, link: string | null): string {
  const lines = [v.ask, `${oneLine(v.title, 100)} (${v.repo})`];
  if (v.why) lines.push(oneLine(v.why, 240));
  if (v.question) lines.push(REPLY_LINE);
  if (v.onlyYou) lines.push(ownerOnlyLine(v.intent));
  return withLink(lines.join("\n"), link);
}

export function proposalText(p: ProposalView, link: string | null): string {
  return withLink(
    `Accept this proposed intent?\n${oneLine(p.title, 100)} (${p.repo || "unknown repo"})`,
    link,
  );
}

export function withLink(body: string, link: string | null): string {
  const cut = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body;
  return link ? `${cut}\n${link}` : cut;
}

/** TG-11: the first line of the message, then how the wait ended. */
export function endedText(original: string, outcome: string): string {
  return `${firstLine(original)}\n${outcome}`;
}
