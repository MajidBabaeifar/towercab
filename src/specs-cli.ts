// `towercab specs check-ids` (PIP-132): a spec PR must not add a requirement ID the base branch already
// has, nor one another open PR adds. Runs in a checkout of the PR, here or in a repo's CI.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { headingIds, idProblems } from "./specids.ts";
import { check, type Tools } from "./tools.ts";

export interface CheckIdsOpts {
  /** The repo checkout. */
  cwd: string;
  /** The base branch ref, e.g. `origin/main`. */
  base: string;
  /** The IDs other open PRs add (the file behind `--prs`), or null when there is no list. */
  prs: { number: number; ids: string[] }[] | null;
}

export interface CheckIdsResult {
  problems: string[];
  /** What was not checked, and why. */
  notes: string[];
}

/** The `--prs` file: `[{"number": 7, "ids": ["PIP-9"]}]`. */
export function readPrList(text: string): { number: number; ids: string[] }[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`the open pull request list isn't JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(v)) throw new Error("the open pull request list must be a JSON array");
  return v.map((p) => {
    const o = p as { number?: unknown; ids?: unknown };
    if (typeof o?.number !== "number" || !Array.isArray(o.ids) || o.ids.some((i) => typeof i !== "string"))
      throw new Error('each open pull request needs a "number" and a list of "ids"');
    return { number: o.number, ids: o.ids as string[] };
  });
}

/** A requirement file: not the README, not the template. */
const isSpecFile = (name: string) => name.endsWith(".md") && !name.startsWith("_") && name !== "README.md";

async function git(tools: Tools, cwd: string, args: string[]): Promise<string> {
  return check(await tools.run("git", args, { cwd, timeoutMs: 60_000 }), `git ${args[0]}`);
}

/** The heading IDs of every `specs/*.md` at `ref`. */
async function idsAt(tools: Tools, cwd: string, ref: string): Promise<Set<string>> {
  const files = (await git(tools, cwd, ["ls-tree", "-r", "--name-only", ref, "--", "specs"]))
    .split("\n")
    .filter((f) => isSpecFile(f.slice(f.lastIndexOf("/") + 1)));
  const ids = new Set<string>();
  for (const f of files)
    for (const id of headingIds(await git(tools, cwd, ["show", `${ref}:${f}`]))) ids.add(id);
  return ids;
}

export async function checkIds(tools: Tools, o: CheckIdsOpts): Promise<CheckIdsResult> {
  const notes: string[] = [];
  const known = await tools.run("git", ["rev-parse", "--verify", "--quiet", `${o.base}^{commit}`], {
    cwd: o.cwd,
    timeoutMs: 60_000,
  });
  if (known.code !== 0) {
    return { problems: [], notes: [`spec IDs not checked: no ${o.base} to compare with`] };
  }
  const specs = join(o.cwd, "specs");
  let names: string[] = [];
  try {
    names = readdirSync(specs).filter(isSpecFile);
  } catch {
    return { problems: [], notes: ["spec IDs not checked: no specs/ folder"] };
  }
  const head = names.flatMap((f) =>
    headingIds(readFileSync(join(specs, f), "utf8")).map((id) => ({ id, file: `specs/${f}` })),
  );
  const mergeBase = (await git(tools, o.cwd, ["merge-base", o.base, "HEAD"])).trim();
  const problems = idProblems({
    head,
    mergeBase: await idsAt(tools, o.cwd, mergeBase),
    base: await idsAt(tools, o.cwd, o.base),
    open: o.prs,
  });
  if (o.prs === null) notes.push("open pull requests not compared: no list given (--prs)");
  return { problems, notes };
}
