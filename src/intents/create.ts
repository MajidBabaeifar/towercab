// The one writer for a new intent (INT-71) and for adding text to an open one (INT-74). The page and
// `towercab add` both come here, so a later store for intents changes this file only.

import type { Config } from "../config.ts";
import { prsOnBranch } from "../github/branches.ts";
import { forgeOf } from "../github/forge.ts";
import type { GitHub } from "../handlers.ts";
import type { Home } from "../home.ts";
import { commitToIntents } from "../pipeline/plan.ts";
import type { Tools } from "../tools.ts";
import { newId, slugOf } from "./id.ts";
import { intentText } from "./store.ts";
import { type Intent, type IntentStore, RefusedError } from "./types.ts";

/** What the owner typed (INT-71): only `repo` and `title` are required. */
export interface Draft {
  repo: string;
  title: string;
  u?: number;
  i?: number;
  a?: number;
  problem?: string;
  outcome?: string;
  affected?: string;
  constraints?: string;
  questions?: string;
}

/** `direct`: the owner or a maintainer, committed to `main`. `proposal`: a contributor, as a pull request. */
export type Mode = "direct" | "proposal";

/** The longest title and section text INT-72 allows. */
export const TITLE_LIMIT = 100;
export const SECTION_LIMIT = 20_000;

/** The sections of the template, in order, and the draft field each takes. */
const SECTIONS = [
  ["Problem", "problem"],
  ["Proposed outcome", "outcome"],
  ["Affected users and systems", "affected"],
  ["Constraints", "constraints"],
  ["Open questions", "questions"],
] as const satisfies readonly (readonly [string, keyof Draft])[];

export interface CreateDeps {
  store: IntentStore;
  config: Pick<Config, "repos">;
  now(): Date;
  /** What a proposal needs (INT-71); a store without GitHub refuses one. */
  proposal?: { config: Config; home: Home; tools: Tools; github: GitHub; who: string } | null;
}

export interface Created {
  id: string;
  /** The intent file in the intents repo; empty for a proposal. */
  path: string;
  proposal: boolean;
  /** The pull request of a proposal. */
  pr?: number;
}

/** INT-72: the draft as it will be written, or a `RefusedError` with the reason; the title is never rewritten. */
export function checkDraft(d: Draft, config: Pick<Config, "repos">, mode: Mode): Draft {
  if (!config.repos.has(d.repo))
    throw new RefusedError(`${d.repo || "(none)"} is not one of Towercab's repos`);
  const title = d.title.trim();
  if (!title) throw new RefusedError("the title must be one non-empty line");
  if (/[\r\n]/.test(d.title)) throw new RefusedError("the title must be one line");
  if (title.length > TITLE_LIMIT) throw new RefusedError(`the title is over ${TITLE_LIMIT} characters`);
  if (/[\p{C}<>`]/u.test(title))
    throw new RefusedError("the title can't hold control characters, <, > or backticks");
  for (const key of ["u", "i"] as const) {
    const v = d[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 5))
      throw new RefusedError(`${key} must be an integer 1-5`);
  }
  if (d.a !== undefined) {
    const top = mode === "proposal" ? 4 : 5;
    if (!Number.isInteger(d.a) || d.a < 0 || d.a > top)
      throw new RefusedError(`a must be an integer 0-${top}`);
  }
  for (const [name, key] of SECTIONS) {
    if ((d[key] ?? "").length > SECTION_LIMIT)
      throw new RefusedError(`${name} is over ${SECTION_LIMIT} characters`);
  }
  return { ...d, title };
}

/** The sections the draft has text for, in the template's order; a `#` line can't open a heading of its own. */
export function bodyOf(d: Draft): string {
  const out: string[] = [];
  for (const [name, key] of SECTIONS) {
    const text = (d[key] ?? "").trim();
    if (!text) continue;
    const lines = text.split("\n").map((l) => (l.replace(/\r$/, "").startsWith("#") ? `\\${l}` : l));
    out.push(`## ${name}\n\n${lines.join("\n")}`);
  }
  return out.join("\n\n");
}

/**
 * INT-71: write the intent. `direct` is one commit to `main` as `towercab add` makes it; `proposal` opens a
 * pull request from `proposal/<key>` with `source: proposal`, and a replay with the same key finds it.
 */
export async function createIntent(d: CreateDeps, draft: Draft, mode: Mode, key?: string): Promise<Created> {
  const c = checkDraft(draft, d.config, mode);
  const body = bodyOf(c);
  const now = d.now();
  if (mode === "direct") {
    const i = await d.store.add({ repo: c.repo, title: c.title, u: c.u, i: c.i, a: c.a, body }, now);
    return { id: i.id, path: `${i.dir}/intent.md`, proposal: false };
  }
  const p = d.proposal;
  const intents = d.store.github();
  if (!p || !intents)
    throw new RefusedError("the intents repo isn't on GitHub, so a proposal can't be opened");
  const branch = `proposal/${key ?? slugOf(c.title)}`;
  const there = (await prsOnBranch(p.github, intents, branch))[0];
  if (there) return { id: "", path: "", proposal: true, pr: there.number };
  const listing = await d.store.list();
  const taken = new Set<string>([
    ...listing.open.map((x) => x.id),
    ...listing.done.map((x) => x.id),
    ...listing.doneIds,
    ...listing.unreadable.flatMap((u) => (u.id ? [u.id] : [])),
  ]);
  const id = newId(now, taken);
  const text = intentText(
    { repo: c.repo, title: c.title, u: c.u, i: c.i, a: c.a, source: "proposal", body },
    now,
  );
  const title = `docs(intents): add ${id} ${c.title}`;
  const cx = { config: p.config, home: p.home, tools: p.tools, github: p.github, store: d.store };
  await commitToIntents(
    cx,
    branch,
    "origin/main",
    { [`intents/${id}-${slugOf(c.title)}/intent.md`]: text },
    title,
    "proposals",
  );
  const pr = await forgeOf(p.github).openPr(intents, {
    base: "main",
    head: branch,
    title,
    body: [
      `Proposed by ${p.who} from Towercab's new intent form.`,
      "Merging this pull request accepts it as work. Closing it says no.",
    ].join("\n\n"),
  });
  if (!pr) throw new Error("GitHub opened the proposal but gave no pull request number");
  return { id, path: "", proposal: true, pr };
}

/** The mission an intent has, as far as INT-74 needs it. */
export interface MissionNow {
  stage: string;
}

/** Mission stages that are still the design step. */
const DESIGN_STAGES = new Set(["pick", "design", "approval:spec"]);

/**
 * INT-74: null when text can be added to `intent`; else why not. Open, at design, and no mission past
 * design. A pull request or an unreadable intent is never here, since it is not an `Intent`.
 */
export function cannotAddTo(intent: Intent, mission?: MissionNow | null): string | null {
  const past = `${intent.id} is already past design, so new text would not change it. Write a new intent instead and link ${intent.id} in it.`;
  if (intent.done)
    return `${intent.id} is ${intent.stage === "dropped" ? "dropped" : "done"}, so it can't take new text. Write a new intent instead and link ${intent.id} in it.`;
  if (intent.stage !== null && intent.stage !== "spec") return past;
  if (mission && !DESIGN_STAGES.has(mission.stage)) return past;
  return null;
}

export const canAddTo = (intent: Intent, mission?: MissionNow | null): boolean =>
  cannotAddTo(intent, mission) === null;

/** INT-74: add each non-blank section of the draft to the intent; title, repo and scores are ignored. */
export async function addToIntent(
  d: Pick<CreateDeps, "store">,
  id: string,
  draft: Draft,
  mission: MissionNow | null | undefined,
  by: string,
  mode: Mode = "direct",
): Promise<Intent> {
  if (mode !== "direct") throw new RefusedError("only a maintainer can add text to an existing intent");
  const l = await d.store.list();
  const found = l.open.find((i) => i.id === id) ?? l.done.find((i) => i.id === id);
  if (!found) throw new RefusedError(`no intent matches ${id}`);
  const why = cannotAddTo(found, mission);
  if (why) throw new RefusedError(why);
  for (const [name, key] of SECTIONS) {
    if ((draft[key] ?? "").length > SECTION_LIMIT)
      throw new RefusedError(`${name} is over ${SECTION_LIMIT} characters`);
  }
  return d.store.update(
    found.id,
    "add text to",
    (e) => {
      for (const [name, key] of SECTIONS) e.addToSection(name, draft[key] ?? "");
    },
    `Added-by: ${by}`,
  );
}
