// The run set (REPO-9): what runs before publish, the fast checks with CI or the full checks
// without, with `{tests}` and `{stems}` filled in.

import type { Tools } from "../tools.ts";
import { checkBase, repoGit, type Verifying } from "./files.ts";

/**
 * The lines to run before publish: without CI, or without a ` ```fast ` block, the ` ```checks `;
 * else the fast lines in order, `{tests}` → the changed test files and `{stems}` → their file
 * stems (none for a file below a subdirectory of `tests/`: a helper), space-separated and
 * shell-quoted. A line with a placeholder that has nothing to stand for is skipped, never run bare.
 */
export function runSet(verifying: Verifying, hasCi: boolean, changedTests: string[]): string[] {
  if (!hasCi || verifying.fast === null) return [...verifying.checks];
  const tests = changedTests.map(quote).join(" ");
  const stems: string[] = [];
  for (const t of changedTests) {
    const s = stem(t);
    if (s !== null && !stems.includes(s)) stems.push(s);
  }
  const stemText = stems.map(quote).join(" ");
  return verifying.fast
    .filter((l) => !(l.includes("{tests}") && tests === ""))
    .filter((l) => !(l.includes("{stems}") && stemText === ""))
    .map((l) => l.replaceAll("{tests}", tests).replaceAll("{stems}", stemText));
}

/**
 * What the build prompt names as the repo's commands: the setup lines, then the run set's lines
 * up to their first placeholder or `$(` (a line that starts with one is left out).
 */
export function allowedCommands(verifying: Verifying, hasCi: boolean): string[] {
  const out = [...verifying.setup];
  if (!hasCi || verifying.fast === null) return [...out, ...verifying.checks];
  for (const l of verifying.fast) {
    const cut = Math.min(...["{", "$("].map((p) => l.indexOf(p)).filter((i) => i >= 0), l.length);
    const prefix = l.slice(0, cut).trim();
    if (prefix) out.push(prefix);
  }
  return out;
}

/** The base branch has `.github/workflows/*.yml` or `*.yaml`: the base's, never the PR's. */
export async function hasCi(tools: Tools, clone: string, base: string): Promise<boolean> {
  checkBase(clone, base);
  const out = await repoGit(tools, clone, [
    "ls-tree",
    "--name-only",
    `refs/remotes/origin/${base}`,
    ".github/workflows/",
  ]);
  return out.split("\n").some((l) => l.endsWith(".yml") || l.endsWith(".yaml"));
}

/** A test path's file name without its last extension; none below a subdirectory of `tests`. */
function stem(path: string): string | null {
  const parts = path.split("/");
  const name = parts.pop()!;
  const at = parts.indexOf("tests");
  if (at >= 0 && at + 1 !== parts.length) return null;
  const dot = name.lastIndexOf(".");
  const s = dot < 0 ? name : name.slice(0, dot);
  return s || null;
}

/** A word shell-quoted where needed. */
export function quote(w: string): string {
  return w !== "" && /^[A-Za-z0-9_./@%+=:,-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`;
}
