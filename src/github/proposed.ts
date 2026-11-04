// Proposed intents (INT-51, INT-52): the open pull requests on the intents repo that add an intent,
// read through `gh` as the App. Read for display only: the intent text reaches no Claude run.

import type { GitHub } from "../handlers.ts";
import { parseIntent } from "../intents/intent.ts";
import { check, type RunResult } from "../tools.ts";
import { jsonStream } from "./prs.ts";

/** What the card shows of the intent file (INT-52). */
export interface ProposedIntent {
  title: string;
  repo: string;
  u: number | null;
  i: number | null;
  a: number | null;
  source: string | null;
}

export interface ProposedPr {
  number: number;
  url: string;
  /** The PR's own title. */
  title: string;
  draft: boolean;
  /** The proposer: the PR author's login; `Towercab` for the App. */
  proposer: string;
  /** Unix seconds. */
  createdAt: number;
  head: string;
  /** The intent file the PR adds, or null. */
  path: string | null;
  /** The intent at the head, when it could be read. */
  intent: ProposedIntent | null;
  /** The intent file at the head SHA. */
  textUrl: string | null;
  /** INT-51: adds exactly one intent file, nothing else but the generated views, and it parses. */
  acceptable: boolean;
  /** Why it is not acceptable (GitHub only, or the file's problem). */
  reason: string | null;
}

/** What the loop knows of the proposed intents (LOOP-92): the last good list and the last failure. */
export interface ProposedState {
  list: ProposedPr[];
  /** Why the last read failed; null when it worked. */
  error: string | null;
  /** Unix seconds of that failure. */
  failedAt: number | null;
}

export interface FileChange {
  filename: string;
  status: string;
}

export const MORE_THAN_ONE = "Changes more than one intent";
export const MORE_THAN_FILE = "Changes more than an intent file";

const INTENT_FILE = /^(?:intents|done)\/[^/]+\/intent\.md$/;
const VIEWS = new Set(["TODO.md", "DONE.md"]);

export interface Classified {
  /** The intent files the PR adds. */
  added: string[];
  /** Null when acceptable, else why only GitHub can take it. */
  reason: string | null;
}

/** INT-51: which PRs add an intent (null: none, so not a proposed intent) and whether one can be accepted here. */
export function classifyFiles(files: FileChange[]): Classified | null {
  const added = files
    .filter((f) => f.status === "added" && INTENT_FILE.test(f.filename))
    .map((f) => f.filename);
  if (added.length === 0) return null;
  const intents = files.filter((f) => INTENT_FILE.test(f.filename));
  if (intents.length > 1) return { added, reason: MORE_THAN_ONE };
  if (files.some((f) => !INTENT_FILE.test(f.filename) && !VIEWS.has(f.filename)))
    return { added, reason: MORE_THAN_FILE };
  return { added, reason: null };
}

/** The intent file's text → what the card shows, or the reason it can't be read. */
export function parseProposed(text: string): { intent: ProposedIntent } | { error: string } {
  try {
    const i = parseIntent(text);
    return { intent: { title: i.title, repo: i.repo, u: i.u, i: i.i, a: i.a, source: i.source } };
  } catch (e) {
    return { error: `Can't read the intent file: ${(e as Error).message}` };
  }
}

type Runner = (args: string[]) => Promise<RunResult>;

/** The files of PR `n` (all pages). A reply that isn't a list counts as no files. */
export async function fetchFiles(run: Runner, repo: string, n: number): Promise<FileChange[]> {
  const out = check(
    await run(["api", "--paginate", `repos/${repo}/pulls/${n}/files?per_page=100`]),
    "gh api files",
  );
  const files: FileChange[] = [];
  for (const page of jsonStream(out, "gh api files")) {
    if (!Array.isArray(page)) continue;
    for (const f of page) {
      if (typeof f === "object" && f !== null && typeof (f as FileChange).filename === "string")
        files.push({ filename: (f as FileChange).filename, status: String((f as FileChange).status ?? "") });
    }
  }
  return files;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** What is kept per (PR, head): the files and the file's text cost calls, so they are read once. */
export type ProposedCache = Map<
  string,
  Pick<ProposedPr, "path" | "intent" | "textUrl" | "acceptable" | "reason"> | null
>;

/** Read the proposed intents of `repo` (`owner/name`). Throws when GitHub can't be read. */
export async function readProposed(
  gh: GitHub,
  repo: string,
  cache: ProposedCache,
  bot: string,
): Promise<ProposedPr[]> {
  const listed = check(
    await gh.gh(repo, [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--base",
      "main",
      "--limit",
      "200",
      "--json",
      "number,title,isDraft,author,createdAt,headRefOid,url",
    ]),
    "gh pr list",
  );
  let rows: unknown;
  try {
    rows = JSON.parse(listed);
  } catch (e) {
    throw new Error(`gh pr list: ${(e as Error).message}`);
  }
  if (!Array.isArray(rows)) throw new Error("gh pr list: not a list");
  const out: ProposedPr[] = [];
  const live = new Set<string>();
  for (const r of rows) {
    if (!isObj(r) || typeof r.number !== "number") continue;
    const n = r.number;
    const head = str(r.headRefOid);
    const key = `${n}:${head}`;
    live.add(key);
    let detail = cache.get(key);
    if (detail === undefined) {
      detail = await detailOf(gh, repo, n, head);
      cache.set(key, detail);
    }
    if (!detail) continue;
    const login = isObj(r.author) ? str(r.author.login) : "";
    const t = Date.parse(str(r.createdAt));
    out.push({
      number: n,
      url: str(r.url) || `https://github.com/${repo}/pull/${n}`,
      title: str(r.title),
      draft: r.isDraft === true,
      proposer: !login || login === bot || login === `app/${bot}` ? "Towercab" : login,
      createdAt: Number.isFinite(t) ? t / 1000 : 0,
      head,
      ...detail,
    });
  }
  for (const k of [...cache.keys()]) if (!live.has(k)) cache.delete(k);
  return out;
}

async function detailOf(gh: GitHub, repo: string, n: number, head: string) {
  const files = await fetchFiles((a) => gh.gh(repo, a), repo, n);
  const c = classifyFiles(files);
  if (!c) return null;
  const path = c.added[0]!;
  const textUrl = `https://github.com/${repo}/blob/${head}/${path}`;
  let intent: ProposedIntent | null = null;
  let problem: string | null = null;
  const raw = await gh.gh(repo, [
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${repo}/contents/${path}?ref=${head}`,
  ]);
  if (raw.code !== 0) throw new Error(`gh api contents: ${(raw.stderr || raw.stdout).trim().split("\n")[0]}`);
  const parsed = parseProposed(raw.stdout);
  if ("intent" in parsed) intent = parsed.intent;
  else problem = parsed.error;
  return {
    path,
    intent,
    textUrl,
    acceptable: c.reason === null && intent !== null,
    reason: c.reason ?? problem,
  };
}
