// Self-update (LOOP-35): when Towercab's own main moves, fast-forward this checkout, install,
// check the new tree, and exit 75 so systemd starts the new code. A failed check rolls back.
// On the release channel (LOOP-150..151) the target is the newest release tag on main instead.

import { join } from "node:path";
import type { UpdateChannel } from "./config.ts";
import type { Tools } from "./tools.ts";

export const RESTART_CODE = 75;

export interface UpdateDeps {
  tools: Tools;
  /** The checkout Towercab runs from. */
  checkout: string;
  /** True when no child runs (the swap waits for it). */
  idle(): boolean;
  /** LOOP-108: the full commit an update already failed on (a main commit or a release tag's commit); no update is tried for it. */
  failed?: string | null;
  /** LOOP-150: what the check follows; default `"main"`. */
  channel?: UpdateChannel;
  /** Where a skipped release tag is explained (LOOP-151). */
  log?(message: string): void;
  /** Tags already explained, so each is logged once while the loop runs. */
  skipped?: Set<string>;
}

export type UpdateResult =
  | { kind: "none"; why: string }
  /** The fetch failed: nothing is known, so a drain in progress stays as it is. */
  | { kind: "unreachable"; why: string }
  /** A target is ahead and children run; `to` is its short commit (or release tag), `target` the full commit. */
  | { kind: "waiting"; behind: number; to: string; target: string }
  | { kind: "updated"; from: string; to: string }
  | { kind: "failed"; why: string; to: string; target: string };

async function git(
  d: Pick<UpdateDeps, "tools" | "checkout">,
  args: string[],
): Promise<{ ok: boolean; out: string }> {
  const r = await d.tools.run("git", args, { cwd: d.checkout, timeoutMs: 120_000 });
  return { ok: r.code === 0, out: (r.code === 0 ? r.stdout : r.stderr).trim() };
}

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** LOOP-151: `v<major>.<minor>.<patch>` and nothing else (no prefix, no pre-release suffix). */
export function isReleaseTag(tag: string): boolean {
  return RELEASE_TAG.test(tag);
}

/** Numeric order of two release tags: negative when `a` is older than `b`. */
export function compareTags(a: string, b: string): number {
  const x = RELEASE_TAG.exec(a)!.slice(1).map(Number);
  const y = RELEASE_TAG.exec(b)!.slice(1).map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}

function lines(out: string): string[] {
  return out.split("\n").filter((l) => l !== "");
}

/** Release tags whose commit is on `origin/main`, newest first; others are skipped and, with `log`, explained once. */
async function releaseTags(
  d: Pick<UpdateDeps, "tools" | "checkout">,
  log?: (message: string) => void,
  skipped: Set<string> = new Set(),
): Promise<{ tag: string; commit: string }[]> {
  const all = lines((await git(d, ["tag", "--list", "v*"])).out).filter(isReleaseTag);
  const found: { tag: string; commit: string }[] = [];
  for (const tag of all) {
    const onMain = await git(d, ["merge-base", "--is-ancestor", `${tag}^{commit}`, "origin/main"]);
    if (!onMain.ok) {
      if (log && !skipped.has(tag)) {
        skipped.add(tag);
        log(`release ${tag} skipped: its commit is not on main`);
      }
      continue;
    }
    found.push({ tag, commit: (await git(d, ["rev-parse", `${tag}^{commit}`])).out });
  }
  return found.sort((a, b) => compareTags(b.tag, a.tag));
}

/** The highest release tag reachable from HEAD, or null. */
async function runningRelease(d: Pick<UpdateDeps, "tools" | "checkout">): Promise<string | null> {
  const tags = lines((await git(d, ["tag", "--merged", "HEAD", "--list", "v*"])).out).filter(isReleaseTag);
  return tags.sort(compareTags).pop() ?? null;
}

export interface VersionInfo {
  commit: string;
  behind: number | null;
  /** The release tag, `v1.1.0-3-g<commit>` past a tag, or the short commit with no tag. */
  name: string;
  /** Release channel only: the highest tag HEAD has, and the newest tag on main when it is newer. */
  release: { running: string | null; available: string | null } | null;
}

/** The value before the first read of the checkout finishes. */
export const UNKNOWN_VERSION: VersionInfo = {
  commit: "unknown",
  behind: null,
  name: "unknown",
  release: null,
};

/**
 * The running commit and version, how far `origin/main` (as last fetched) is ahead of it, and, on the
 * release channel, the release waiting (LOOP-152). Reads local refs only: no fetch.
 */
export async function version(d: Pick<UpdateDeps, "tools" | "checkout" | "channel">): Promise<VersionInfo> {
  const head = await git(d, ["rev-parse", "--short", "HEAD"]);
  const behind = await git(d, ["rev-list", "--count", "HEAD..origin/main"]);
  const commit = head.ok ? head.out : "unknown";
  const described = await git(d, ["describe", "--tags", "--match", "v[0-9]*"]);
  let release: { running: string | null; available: string | null } | null = null;
  if (d.channel === "release") {
    const running = await runningRelease(d);
    const latest = (await releaseTags(d))[0]?.tag ?? null;
    release = {
      running,
      available: latest && (!running || compareTags(latest, running) > 0) ? latest : null,
    };
  }
  return {
    commit,
    behind: behind.ok ? Number(behind.out) : null,
    name: described.ok ? described.out : commit,
    release,
  };
}

/** One self-update check (the loop every 60 s when `[update].auto`; `towercab update` at once). */
export async function checkUpdate(d: UpdateDeps): Promise<UpdateResult> {
  const release = d.channel === "release";
  const branch = await git(d, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const onBranch = branch.ok && branch.out === "main";
  // A detached HEAD at a release tag is acceptable too (LOOP-151).
  const onTag =
    branch.ok &&
    branch.out === "HEAD" &&
    lines((await git(d, ["tag", "--points-at", "HEAD"])).out).some(isReleaseTag);
  if (!onBranch && !onTag)
    return { kind: "none", why: `the checkout is on ${branch.out || "no branch"}, not main` };
  const status = await git(d, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok || status.out !== "") return { kind: "none", why: "the checkout has local changes" };
  const fetch = await git(
    d,
    release
      ? ["fetch", "--quiet", "--tags", "--force", "origin", "main"]
      : ["fetch", "--quiet", "origin", "main"],
  );
  if (!fetch.ok) return { kind: "unreachable", why: `fetch failed: ${fetch.out.split("\n")[0]}` };

  let target: string;
  let label: string;
  let behind = 1;
  let move: () => Promise<{ ok: boolean; out: string }>;
  if (release) {
    const latest = (await releaseTags(d, d.log, d.skipped))[0];
    if (!latest) return { kind: "none", why: "no release tag on main yet" };
    const running = await runningRelease(d);
    if (running && compareTags(latest.tag, running) <= 0)
      return { kind: "none", why: `up to date (${running})` };
    target = latest.commit;
    label = latest.tag;
    move = async () => {
      const r = await git(d, ["checkout", "--quiet", "--detach", latest.tag]);
      return r.ok ? r : { ok: false, out: `checkout failed: ${r.out.split("\n")[0]}` };
    };
  } else {
    behind = Number((await git(d, ["rev-list", "--count", "HEAD..origin/main"])).out || "0");
    // On a tag the checkout goes back to main even when main has not moved.
    if (!onTag && behind === 0) return { kind: "none", why: "up to date" };
    if (!onTag && !(await git(d, ["merge-base", "--is-ancestor", "HEAD", "origin/main"])).ok) {
      return { kind: "none", why: "origin/main isn't ahead of this commit" };
    }
    target = (await git(d, ["rev-parse", "origin/main"])).out;
    label = target.slice(0, 7);
    move = async () => {
      if (onTag) {
        const back = await git(d, ["checkout", "--quiet", "main"]);
        if (!back.ok) return { ok: false, out: `checkout failed: ${back.out.split("\n")[0]}` };
      }
      return git(d, ["merge", "--ff-only", "--quiet", "origin/main"]);
    };
  }
  if (d.failed && d.failed === target) return { kind: "none", why: `the update to ${label} failed before` };
  if (!d.idle()) return { kind: "waiting", behind, to: label, target };

  const from = (await git(d, ["rev-parse", "HEAD"])).out;
  const back = async () => {
    // Back where it was: on its branch, or detached at the commit (a release tag).
    if (branch.out === "main") {
      await git(d, ["checkout", "--quiet", "main"]);
      await git(d, ["reset", "--hard", "--quiet", from]);
    } else await git(d, ["checkout", "--quiet", "--detach", from]);
  };
  const moved = await move();
  if (!moved.ok) {
    await back();
    const why = moved.out.startsWith("checkout failed")
      ? moved.out
      : `merge failed: ${moved.out.split("\n")[0]}`;
    return { kind: "failed", why, to: label, target };
  }
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
    (await step(join(d.checkout, "bin", "towercab"), ["doctor", "--quick", "--for-update"]));
  if (failure) {
    await back();
    if (lockChanged) await step("npm", ["ci", "--no-audit", "--no-fund"]);
    return { kind: "failed", why: failure, to: label, target };
  }
  return { kind: "updated", from: from.slice(0, 7), to: release ? label : to.slice(0, 7) };
}
