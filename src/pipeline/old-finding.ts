// A secrets finding in a commit older than the PR's head (PIP-192, PIP-193, PIP-196): decided in code
// whether the repair round may only ignore it by fingerprint, must ask the owner, or fixes the code.

import { LOG_TAIL } from "./job-log.ts";
import type { Question } from "./schemas.ts";

export interface Finding {
  fingerprint: string;
  commit: string;
  file: string;
  rule: string;
  line: number;
}

export type Verdict =
  | { kind: "ignore"; findings: Finding[] }
  | { kind: "ask"; findings: Finding[] }
  | { kind: "normal" };

/** Reads git in the mission's checkout: the output of `git <args>`, throwing when git fails. */
export type ReadGit = (args: string[]) => Promise<string>;

const FINGERPRINT = /^\s*Fingerprint:\s*(\S+)\s*$/;
const PARTS = /^([0-9a-f]{7,40}):(.+):([^:]+):(\d+)$/;

/** The findings of a gitleaks log; null unless every `RuleID` block has one parseable `Fingerprint`. */
export function parseFindings(log: string): Finding[] | null {
  const lines = log.split("\n");
  const rules = lines.filter((l) => /^\s*RuleID:/.test(l)).length;
  const prints = lines.map((l) => FINGERPRINT.exec(l)?.[1]).filter((f): f is string => Boolean(f));
  if (prints.length === 0 || prints.length !== rules) return null;
  const out: Finding[] = [];
  for (const fingerprint of prints) {
    const m = PARTS.exec(fingerprint);
    if (!m) return null;
    out.push({ fingerprint, commit: m[1]!, file: m[2]!, rule: m[3]!, line: Number(m[4]) });
  }
  return out;
}

/** PIP-196: a path of a test or fixture; nothing else counts, and a path that climbs out never does. */
export function isTestPath(path: string): boolean {
  if (path.startsWith("/") || path.split("/").includes("..")) return false;
  const dirs = path.split("/").slice(0, -1);
  if (dirs.some((d) => ["tests", "test", "__tests__", "fixtures"].includes(d))) return true;
  return /\.(?:test|spec)\./.test(path.split("/").at(-1) ?? "");
}

/** Whether the flagged line of `f` is gone at `head`; null when it can't be told. */
async function goneAtHead(read: ReadGit, head: string, f: Finding): Promise<boolean | null> {
  let full: string;
  try {
    full = (await read(["rev-parse", "--verify", "--quiet", `${f.commit}^{commit}`])).trim();
    if (!full || full === head) return null;
    await read(["merge-base", "--is-ancestor", full, head]);
  } catch {
    return null;
  }
  let old: string;
  try {
    old = (await read(["show", `${full}:${f.file}`])).split("\n")[f.line - 1]?.trim() ?? "";
  } catch {
    return null;
  }
  if (!old) return null;
  let now: string;
  try {
    now = await read(["show", `${head}:${f.file}`]);
  } catch {
    // The commit and head are readable, so the file is not at the head.
    return true;
  }
  return !now.split("\n").some((l) => l.trim() === old);
}

/**
 * The verdict for the failed jobs' own logs (`jobs`: one cut log per failed check, all of them).
 * Anything unclear is `normal`: the code is fixed as before, also for a `head` that was already given an
 * ignore round or a question (`handled`).
 */
export async function classify(
  read: ReadGit,
  head: string,
  jobs: string[],
  handled: Record<string, boolean> = {},
): Promise<Verdict> {
  if (jobs.length === 0 || handled[head]) return { kind: "normal" };
  const findings: Finding[] = [];
  for (const job of jobs) {
    if (job.length >= LOG_TAIL) return { kind: "normal" };
    const f = parseFindings(job);
    if (!f) return { kind: "normal" };
    findings.push(...f);
  }
  for (const f of findings) {
    if ((await goneAtHead(read, head, f)) !== true) return { kind: "normal" };
  }
  return { kind: findings.every((f) => isTestPath(f.file)) ? "ignore" : "ask", findings };
}

/**
 * PIP-192: whether an ignore round's staged change is allowed to be pushed: `.gitleaksignore` alone,
 * only added lines, and those lines exactly the listed fingerprints.
 */
export function ignoreRoundOk(staged: string, diff: string, fingerprints: string[]): boolean {
  if (staged.trim() !== ".gitleaksignore") return false;
  const body = diff
    .split("\n")
    .filter((l) => !/^(?:diff |index |--- |\+\+\+ |@@ |new file|similarity)/.test(l));
  const lines = body.filter((l) => l !== "");
  if (lines.some((l) => !l.startsWith("+"))) return false;
  const added = lines.map((l) => l.slice(1).trim());
  return (
    added.length === fingerprints.length &&
    new Set(added).size === added.length &&
    fingerprints.every((f) => added.includes(f))
  );
}

const where = (f: Finding) => `${f.rule} in ${f.file} line ${f.line}, commit ${f.commit.slice(0, 7)}`;

/** The repair details of an ignore round (PIP-192): fingerprints, files and lines, never a value. */
export function ignoreDetails(findings: Finding[]): string {
  return [
    "The secrets check fails only on commits older than the PR's head, in test or fixture files, and the head no longer holds the flagged text.",
    "Do not change any code. Add exactly these lines to `.gitleaksignore` (create the file if it is missing), one per line, and change nothing else:",
    "",
    ...findings.map((f) => f.fingerprint),
    "",
    "Findings:",
    ...findings.map((f) => `- ${where(f)}`),
  ].join("\n");
}

/** The question for an old finding outside tests and fixtures (PIP-196). */
export function oldFindingQuestion(findings: Finding[]): Question {
  return {
    context: `The secrets check fails on commits older than the PR's head, and the head no longer holds the flagged text. Towercab does not ignore these on its own because the files are not tests or fixtures, so the value may be a real key that needs rotating:\n${findings.map((f) => `- ${where(f)}`).join("\n")}`,
    question: "Has the key been rotated, or is it a fake you want ignored?",
    options: [
      {
        option: "Rotate the key if it is real, then reply to say so",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "Towercab goes on and fixes the red check in the code, as for any other failure.",
        do: "continue",
      },
      {
        option: "Drop this change",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "The work stops and nothing more is pushed.",
        do: "drop",
      },
    ],
    recommendation:
      "Check the key in each commit first: if it is real, rotate it, then reply so Towercab can go on.",
  };
}
