// The `pick` stage (LOOP-5, LOOP-8): fetch Towercab's clone, load the repo files, make the checkout.

import { ensureClone, freshCheckout, git } from "../checkout.ts";
import { isGitlab } from "../forge/types.ts";
import { type Ctx, EnvError, type Handler, type Progress } from "../handlers.ts";
import { ok, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { RepoError } from "../repo/files.ts";
import { dropSetup, getSetup, putSetup, startSetup, WAIT_PREFIX } from "../setup-checks.ts";
import { moveIds, parseIds } from "../specids.ts";
import { asEnv, cloneOf, intentOf, prUrl, repoFiles, repoFilesWait } from "./common.ts";
import { takenIds } from "./design.ts";

const prefixOf = (id: string) => id.slice(0, id.lastIndexOf("-"));

/**
 * PIP-131: the IDs the intent reserves (`spec IDs:` in `## Proposed outcome`) are checked against the
 * base branch and the other open spec PRs. A prefix with a clash gets its whole reserved range moved to
 * the next free numbers, written back to the intent; no clash, or open PRs that can't be read (the design
 * checks again before the spec PR opens), leaves the intent untouched.
 */
async function reserveIds(cx: Ctx, m: Mission): Promise<void> {
  const intent = await intentOf(cx, m);
  // A fresh attempt after the spec PR opened or merged: the IDs on base or in that PR are this intent's own.
  if (intent.specPr || m.spec_pr) return;
  const line = /spec IDs:\s*([^\n]+)/i.exec(intent.sections.get("Proposed outcome") ?? "");
  const reserved = line ? parseIds(line[1]!) : [];
  if (!reserved.length) return;
  const t = await takenIds(cx, m);
  if (t.unchecked !== null) return;
  const used = new Set([...t.base, ...t.open.flatMap((p) => p.ids)]);
  const clash = new Set(reserved.filter((id) => used.has(id)).map(prefixOf));
  if (!clash.size) return;
  const moving = reserved.filter((id) => clash.has(prefixOf(id)));
  const map = moveIds(moving, [...used, ...reserved.filter((id) => !clash.has(prefixOf(id)))]);
  cx.record(m, "reserve", {}, { idsRenumbered: Object.fromEntries(map) });
  try {
    await cx.store.update(m.intent, "renumber spec IDs", (e) => e.replaceInBody(map));
    cx.log(
      `${m.intent}: reserved spec IDs were taken, moved: ${[...map].map(([a, b]) => `${a} → ${b}`).join(", ")}`,
    );
  } catch (e) {
    cx.log(`${m.intent}: couldn't write the new spec IDs back to the intent: ${(e as Error).message}`);
  }
}

/** Seconds between looks at a setup that is still being drafted. */
const SETUP_POLL_S = 5;

/**
 * REPO-5, REPO-36, REPO-37: no checks block on the base. The first intent of the repo starts the setup (the
 * loop's job drafts and opens the PR); every intent waits on it with the PR's number, and carries on when it
 * merges. Only a setup that found nothing, or whose PR was closed, asks the owner.
 */
async function settingUp(cx: Ctx, m: Mission): Promise<Progress> {
  const repo = cx.repo(m);
  if (isGitlab(repo.github)) return { done: wait("add CLAUDE.md verifying block") };
  let rec = getSetup(cx.db, repo.name);
  // Merged but the base still has no block (it was removed since), or the owner answered an ask: a new try.
  if (rec?.state === "merged") rec = null;
  if ((rec?.state === "failed" || rec?.state === "closed") && rec.asked.includes(m.intent)) rec = null;
  if (!rec) {
    startSetup(cx.db, repo);
    return { poll: SETUP_POLL_S };
  }
  if (rec.state === "drafting" || rec.state === "pushing") return { poll: SETUP_POLL_S };
  if (rec.state === "open") {
    return {
      done: wait(
        `${WAIT_PREFIX}: #${rec.pr}`,
        `Towercab opened a pull request that adds checks to ${repo.github}: ${prUrl(repo.github, rec.pr!)}`,
      ),
    };
  }
  if (!rec.asked.includes(m.intent)) putSetup(cx.db, repo.name, { ...rec, asked: [...rec.asked, m.intent] });
  const why =
    rec.state === "closed"
      ? `The pull request that adds checks (#${rec.pr}) was closed without merging.`
      : rec.tried.length
        ? `Towercab tried ${rec.tried.join(", ")} and none passed on ${rec.base}: ${rec.lastFailure}.`
        : `Towercab couldn't set up checks on ${rec.base}: ${rec.lastFailure ?? "nothing in the repo to draft checks from"}.`;
  return { done: wait("add CLAUDE.md verifying block", why) };
}

export const pickHandler: Handler = {
  async step(cx: Ctx, m: Mission): Promise<Progress> {
    const repo = cx.repo(m);
    const clone = cloneOf(cx, m);
    try {
      await ensureClone(cx.tools, clone, repo, await cx.github.gitAuth(repo.github));
    } catch (e) {
      throw e instanceof EnvError ? e : asEnv(e);
    }
    try {
      await repoFiles(cx, m);
    } catch (e) {
      // REPO-5: a repo with no checks gets them set up, not a question.
      if (e instanceof RepoError && e.kind === "noVerifying") return settingUp(cx, m);
      const w = repoFilesWait(e);
      if (w) return { done: w };
      throw e;
    }
    // The repo has checks now: an ended record has done its work (waiting intents carry on without it).
    const ended = getSetup(cx.db, repo.name);
    if (ended && ["merged", "closed", "failed"].includes(ended.state)) dropSetup(cx.db, repo.name);
    await reserveIds(cx, m);
    const base = (await git(cx.tools, clone, ["rev-parse", `refs/remotes/origin/${repo.base}`])).trim();
    await freshCheckout(cx.tools, clone, cx.checkout(m), repo.base, m.branch);
    return { done: ok({ set: { base_sha: base } }) };
  },
  async finish() {
    return { poll: 0 };
  },
};
