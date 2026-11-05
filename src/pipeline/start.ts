// The `pick` stage (LOOP-5, LOOP-8): fetch Towercab's clone, load the repo files, make the checkout.

import { ensureClone, freshCheckout, git } from "../checkout.ts";
import { type Ctx, EnvError, type Handler, type Progress } from "../handlers.ts";
import { ok } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { moveIds, parseIds } from "../specids.ts";
import { asEnv, cloneOf, intentOf, repoFiles, repoFilesWait } from "./common.ts";
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
      const w = repoFilesWait(e);
      if (w) return { done: w };
      throw e;
    }
    await reserveIds(cx, m);
    const base = (await git(cx.tools, clone, ["rev-parse", `refs/remotes/origin/${repo.base}`])).trim();
    await freshCheckout(cx.tools, clone, cx.checkout(m), repo.base, m.branch);
    return { done: ok({ set: { base_sha: base } }) };
  },
  async finish() {
    return { poll: 0 };
  },
};
