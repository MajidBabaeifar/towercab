// Self-update (LOOP-35): when Towercab's own main moves, fast-forward this checkout, install,
// check the new tree, and exit 75 so systemd starts the new code. A failed check rolls back.

import { join } from "node:path";
import type { Tools } from "./tools.ts";

export const RESTART_CODE = 75;

export interface UpdateDeps {
  tools: Tools;
  /** The checkout Towercab runs from. */
  checkout: string;
  /** True when no child runs (the swap waits for it). */
  idle(): boolean;
}

export type UpdateResult =
  | { kind: "none"; why: string }
  | { kind: "waiting"; behind: number }
  | { kind: "updated"; from: string; to: string }
  | { kind: "failed"; why: string };

async function git(d: UpdateDeps, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await d.tools.run("git", args, { cwd: d.checkout, timeoutMs: 120_000 });
  return { ok: r.code === 0, out: (r.code === 0 ? r.stdout : r.stderr).trim() };
}

/** The running commit and how far `origin/main` (as last fetched) is ahead of it. */
export async function version(
  d: Pick<UpdateDeps, "tools" | "checkout">,
): Promise<{ commit: string; behind: number | null }> {
  const deps = { ...d, idle: () => true };
  const head = await git(deps, ["rev-parse", "--short", "HEAD"]);
  const behind = await git(deps, ["rev-list", "--count", "HEAD..origin/main"]);
  return { commit: head.ok ? head.out : "unknown", behind: behind.ok ? Number(behind.out) : null };
}

/** One self-update check (the loop every 60 s when `[update].auto`; `towercab update` at once). */
export async function checkUpdate(d: UpdateDeps): Promise<UpdateResult> {
  const branch = await git(d, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok || branch.out !== "main")
    return { kind: "none", why: `the checkout is on ${branch.out || "no branch"}, not main` };
  const status = await git(d, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok || status.out !== "") return { kind: "none", why: "the checkout has local changes" };
  const fetch = await git(d, ["fetch", "--quiet", "origin", "main"]);
  if (!fetch.ok) return { kind: "none", why: `fetch failed: ${fetch.out.split("\n")[0]}` };
  const behind = Number((await git(d, ["rev-list", "--count", "HEAD..origin/main"])).out || "0");
  if (behind === 0) return { kind: "none", why: "up to date" };
  if (!(await git(d, ["merge-base", "--is-ancestor", "HEAD", "origin/main"])).ok) {
    return { kind: "none", why: "origin/main isn't ahead of this commit" };
  }
  if (!d.idle()) return { kind: "waiting", behind };

  const from = (await git(d, ["rev-parse", "HEAD"])).out;
  const merge = await git(d, ["merge", "--ff-only", "--quiet", "origin/main"]);
  if (!merge.ok) return { kind: "failed", why: `merge failed: ${merge.out.split("\n")[0]}` };
  const to = (await git(d, ["rev-parse", "HEAD"])).out;
  const changed = (await git(d, ["diff", "--name-only", from, to])).out.split("\n");
  const lockChanged = changed.includes("package-lock.json");
  const uiChanged = changed.some((f) => f.startsWith("ui/"));

  const step = async (cmd: string, args: string[]): Promise<string | null> => {
    const r = await d.tools.run(cmd, args, { cwd: d.checkout, timeoutMs: 600_000 });
    return r.code === 0
      ? null
      : `${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`;
  };
  const failure =
    (lockChanged ? await step("npm", ["ci", "--no-audit", "--no-fund"]) : null) ??
    (uiChanged || lockChanged ? await step("npm", ["run", "build:ui"]) : null) ??
    (await step(join(d.checkout, "bin", "towercab"), ["doctor", "--quick"]));
  if (failure) {
    await git(d, ["reset", "--hard", "--quiet", from]);
    if (lockChanged) await step("npm", ["ci", "--no-audit", "--no-fund"]);
    return { kind: "failed", why: failure };
  }
  return { kind: "updated", from: from.slice(0, 7), to: to.slice(0, 7) };
}
