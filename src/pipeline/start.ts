// The `pick` stage (LOOP-5, LOOP-8): fetch Towercab's clone, load the repo files, make the checkout.

import { ensureClone, freshCheckout, git } from "../checkout.ts";
import { type Ctx, EnvError, type Handler, type Progress } from "../handlers.ts";
import { ok } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { asEnv, cloneOf, repoFiles, repoFilesWait } from "./common.ts";

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
    const base = (await git(cx.tools, clone, ["rev-parse", `refs/remotes/origin/${repo.base}`])).trim();
    await freshCheckout(cx.tools, clone, cx.checkout(m), repo.base, m.branch);
    return { done: ok({ set: { base_sha: base } }) };
  },
  async finish() {
    return { poll: 0 };
  },
};
