// PIP-167, PIP-168, PIP-169: before a conflict goes to the worker, Towercab tries to resolve it by code.
// Each conflicted file is resolved in memory (additive hunks keep both sides; else the PR's own diff is
// applied onto the base branch's file); only when every file resolves are the files written and the merge
// committed as Towercab's own. Any doubt → null, and the tree is left conflicted for the worker.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Ctx } from "../handlers.ts";
import type { Mission } from "../mission.ts";
import { glob } from "../repo/protected.ts";
import { resolveText } from "./additive.ts";
import { botAuthor, coGit, data, repoFiles } from "./common.ts";

/** `git <args>` in the checkout (a failing command throws). */
export type Git = (args: string[]) => Promise<string>;

/** What a mechanical resolution did, kept on the mission for verify and the review (PIP-169). */
export interface Mech {
  /** The PR's head before the merge: what a failed attempt goes back to. */
  ours: string;
  /** The base-side head it merged in: with `ours`, the PR's own diff before the merge (`theirs...ours`). */
  theirs: string;
  files: string[];
  /** One line per file: how it was resolved. */
  notes: string[];
  /** The merge review found both sides kept. */
  reviewed?: boolean;
}

const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];

/** Whether a unified diff removes or changes a line. */
export function removesLines(diff: string): boolean {
  return diff.split("\n").some((l) => l.startsWith("-") && !l.startsWith("---"));
}

async function hasMerge(git: Git): Promise<boolean> {
  return git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
    () => true,
    () => false,
  );
}

/** The stages (1 base, 2 ours, 3 theirs) the index holds for `file`. */
async function stages(git: Git, file: string): Promise<Set<string>> {
  const out = await git(["ls-files", "-u", "--", file]);
  return new Set(
    out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[2] ?? ""),
  );
}

/** PIP-168: the PR's own diff of `file` (merge base → PR head) applied onto the file as the other side has it. */
export async function applyOwnDiff(git: Git, file: string): Promise<string | null> {
  const mb = (await git(["merge-base", "HEAD", "MERGE_HEAD"])).trim();
  const own = await git([...DIFF, mb, "HEAD", "--", file]);
  if (!own.trim() || removesLines(own)) return null;
  const tmp = mkdtempSync(join(tmpdir(), "towercab-merge-"));
  try {
    const target = join(tmp, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await git(["show", `MERGE_HEAD:${file}`]));
    const patch = join(tmp, ".own.patch");
    writeFileSync(patch, own);
    await git(["-C", tmp, "apply", "--whitespace=nowarn", patch]);
    return readFileSync(target, "utf8");
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Resolve the conflicted `files` of the merge in progress in `dir`, commit it, and say what was done;
 * null (the tree conflicted as before) when any file needs a person or the worker.
 */
export async function resolveConflicts(
  git: Git,
  dir: string,
  files: string[],
  author: string[],
  label: string,
): Promise<Mech | null> {
  if (files.length === 0 || !(await hasMerge(git))) return null;
  const ours = (await git(["rev-parse", "HEAD"])).trim();
  const theirs = (await git(["rev-parse", "MERGE_HEAD"])).trim();
  const touched: string[] = [];
  const resolved = new Map<string, string>();
  const notes: string[] = [];
  let written = false;
  let committed = false;
  try {
    for (const f of files) {
      if ((await stages(git, f)).size !== 3) return null;
      await git(["checkout", "--conflict=diff3", "--", f]);
      touched.push(f);
      const text = readFileSync(join(dir, f), "utf8");
      if (text.includes("\0")) return null;
      const r = resolveText(text);
      if (r) {
        resolved.set(f, r.text);
        notes.push(`${f}: ${r.hunks} conflicting hunk${r.hunks === 1 ? "" : "s"}, both sides kept`);
        continue;
      }
      const applied = await applyOwnDiff(git, f);
      if (applied === null) return null;
      resolved.set(f, applied);
      notes.push(`${f}: the PR's own change applied onto the base branch's file`);
    }
    written = true;
    for (const [f, text] of resolved) {
      writeFileSync(join(dir, f), text);
      await git(["add", "--", f]);
    }
    if ((await git(["diff", "--name-only", "--diff-filter=U"])).trim()) throw new Error("still unmerged");
    await git([
      ...author,
      "commit",
      "--quiet",
      "-m",
      `Merge ${label}: both sides only added, resolved by Towercab`,
    ]);
    committed = true;
    return { ours, theirs, files, notes };
  } catch {
    return null;
  } finally {
    // A failed attempt leaves the conflict as the merge made it, for the worker.
    if (!committed) {
      if (written) {
        await git(["reset", "--hard", "--quiet", ours]).catch(() => "");
        await git(["merge", "--no-edit", theirs]).catch(() => "");
      } else {
        for (const f of touched) await git(["checkout", "-m", "--", f]).catch(() => "");
      }
    }
  }
}

/** PIP-167 on the mission's checkout; never throws: a failure is "not resolved". */
export async function mechanicalMerge(
  cx: Ctx,
  m: Mission,
  files: string[],
  label: string,
): Promise<Mech | null> {
  try {
    const author = await botAuthor(cx, cx.repo(m).github);
    const mech = await resolveConflicts((args) => coGit(cx, m, args), cx.checkout(m), files, author, label);
    if (mech) cx.log(`${m.intent}: merged ${label} without the worker: ${mech.notes.join("; ")}`);
    return mech;
  } catch (e) {
    cx.log(`${m.intent}: the mechanical merge failed (${(e as Error).message}); the worker resolves it`);
    return null;
  }
}

/** PIP-153: the test files a mechanical merge changed, which the test lock treats as a merge of the base. */
export async function testsOf(cx: Ctx, m: Mission, files: string[]): Promise<string[]> {
  const ms = (await repoFiles(cx, m)).towercab.tests.map((g) => glob(g));
  const opened = new Set(data(m).mergeOpened ?? []);
  for (const f of files) if (ms.some((match) => match(f))) opened.add(f);
  return [...opened];
}
