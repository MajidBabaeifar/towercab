// JIRA-9: a ticket's key in branch names, PR titles and commit scopes; an intent without one is unchanged.

import { expect, test } from "vitest";
import type { Result } from "../../src/forge.ts";
import type { Intent } from "../../src/intents/types.ts";
import type { Mission } from "../../src/mission.ts";
import { codePrTitle, commitTitle, docsCommit, docsPrTitle } from "../../src/pipeline/common.ts";
import { planBranch } from "../../src/pipeline/plan.ts";
import { DIR, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

const mission = (design: Record<string, unknown> = {}) =>
  ({
    data: JSON.stringify({ design: { type: "feat", scope: "web", subject: "Export invoices", ...design } }),
  }) as Mission;
const keyed = (jira: string | null) => ({ title: "Export", slug: "export", id: "1", jira }) as Intent;

/** A whole change for an intent with a key, to the end. */
async function landed(extra: string): Promise<{ p: Pipe; subjects: (string | undefined)[] }> {
  const p = new Pipe(TARGET, intents(intent({ extra })));
  happy(p);
  const subjects: (string | undefined)[] = [];
  // The fake forge's own signature predates the squash subject, so it is wrapped through a wider one.
  const merge = p.forge.mergePr.bind(p.forge) as (r: string, n: number, o: object) => Promise<Result>;
  (p.forge as { mergePr: unknown }).mergePr = async (repo: string, n: number, o: { subject?: string }) => {
    subjects.push(o.subject);
    return merge(repo, n, o);
  };
  await p.start();
  const { ownerMerges } = await import("../helpers/flows.ts");
  const n = await p.until(() => {
    ownerMerges(p);
    return p.mission()?.stage === "done";
  }, 80);
  expect(n, p.moves()).toBeGreaterThan(0);
  return { p, subjects };
}

test("jira: the key is in the branch name", async () => {
  const { p } = await landed("jira: ABC-123\n");
  try {
    const m = p.mission()!;
    expect(m.branch).toBe(`towercab/${ID}-ABC-123-${SLUG}`);
    // The spec branch follows the code branch; the plan branch is on the intents repo.
    expect(p.prs.some((x) => x.head === `${m.branch}-spec`)).toBe(true);
    expect(p.prs.some((x) => x.head === `plan/${ID}-ABC-123-${SLUG}`)).toBe(true);
    expect(planBranch({ id: ID, slug: SLUG, jira: "ABC-123" } as Intent)).toBe(`plan/${ID}-ABC-123-${SLUG}`);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("jira: every PR title starts with the key", async () => {
  const { p } = await landed("jira: ABC-123\n");
  try {
    const titles = p.prs.map((x) => x.title);
    expect(titles.length).toBeGreaterThanOrEqual(3);
    for (const t of titles) expect(t, t).toMatch(/^ABC-123: /);
    expect(titles).toContain("ABC-123: docs(specs): show a greeting");
    expect(titles).toContain("ABC-123: docs(plan): show a greeting");
    expect(titles.some((t) => /^ABC-123: feat: show a greeting$/.test(t))).toBe(true);
    expect(codePrTitle(mission(), keyed("ABC-123"))).toBe("ABC-123: feat(web): export invoices");
    expect(docsPrTitle("specs", mission(), keyed("ABC-123"))).toBe("ABC-123: docs(specs): export invoices");
    expect(docsPrTitle("plan", mission(), keyed("ABC-123"))).toBe("ABC-123: docs(plan): export invoices");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("jira: commits use the key as scope", async () => {
  // At a1 each PR waits for the owner, so every branch is still there to read.
  const p = new Pipe(TARGET, intents(intent({ a: 1, extra: "jira: ABC-123\n" })));
  happy(p);
  await p.start();
  try {
    // The commits are read where each branch still is: before its PR is merged.
    const log = (repo: string, range: string) =>
      git(p.bareOf(`owner/${repo}`), "log", "--format=%s", range)
        .trim()
        .split("\n");
    const spec = await p.until(() => p.mission()?.stage === "approval:spec", 40);
    expect(spec, p.moves()).toBeGreaterThan(0);
    const m = p.mission()!;
    expect(log("web", `main..${m.branch}-spec`)).toEqual(["docs(ABC-123): show a greeting"]);
    const { ownerMerges } = await import("../helpers/flows.ts");
    const plan = await p.until(() => {
      if (p.mission()?.stage === "approval:spec") ownerMerges(p);
      return p.mission()?.stage === "approval:plan";
    }, 40);
    expect(plan, p.moves()).toBeGreaterThan(0);
    expect(log("intents", `main..plan/${ID}-ABC-123-${SLUG}`)).toEqual(["docs(ABC-123): show a greeting"]);
    ownerMerges(p);
    const code = await p.until(() => p.mission()?.stage === "approval:merge", 60);
    expect(code, p.moves()).toBeGreaterThan(0);
    expect(log("web", `main..${p.mission()!.branch}`)).toContain("feat(ABC-123): show a greeting");
    expect(commitTitle(mission(), keyed("ABC-123"))).toBe("feat(ABC-123): export invoices");
    expect(commitTitle(mission({ breaking: true }), keyed("ABC-123"))).toBe(
      "feat(ABC-123)!: export invoices",
    );
    expect(docsCommit("specs", mission(), keyed("ABC-123"))).toBe("docs(ABC-123): export invoices");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("jira: the squash commit uses the key as scope", async () => {
  const { p, subjects } = await landed("jira: ABC-123\n");
  try {
    // The PR title starts with the key, so Towercab's own merge sets the commit's title itself.
    expect(subjects).toContain("feat(ABC-123): show a greeting");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("jira: stages find a PR whose title has the key prefix", async () => {
  const { p } = await landed("jira: ABC-123\n");
  try {
    // The spec, plan and code PRs are all found by their head branch, whatever their title starts with:
    // the mission got to done through each of them.
    const m = p.mission()!;
    expect(m.spec_pr && m.plan_pr && m.pr).toBeTruthy();
    expect(p.prNo("web", m.pr!).title).toMatch(/^ABC-123: /);
    expect(p.prNo("web", m.pr!).head).toBe(m.branch);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("jira: an intent without a key keeps its branch and titles", async () => {
  const { p, subjects } = await landed("");
  try {
    const m = p.mission()!;
    expect(m.branch).toBe(`towercab/${ID}-${SLUG}`);
    expect(p.prs.map((x) => x.title)).toEqual(
      expect.arrayContaining([
        "docs(specs): show a greeting",
        "docs(plan): show a greeting",
        "feat: show a greeting",
      ]),
    );
    expect(subjects.every((s) => s === undefined)).toBe(true);
    expect(DIR).toContain(ID);
    expect(commitTitle(mission(), keyed(null))).toBe("feat(web): export invoices");
    expect(codePrTitle(mission(), keyed(null))).toBe("feat(web): export invoices");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("jira: a malformed key is left out", () => {
  for (const bad of ["abc-123", "ABC123", "ABC-", "A-1", "ABC-123 x", "../x-1", ""]) {
    expect(commitTitle(mission(), keyed(bad)), bad).toBe("feat(web): export invoices");
    expect(codePrTitle(mission(), keyed(bad)), bad).toBe("feat(web): export invoices");
    expect(docsPrTitle("specs", mission(), keyed(bad)), bad).toBe("docs(specs): export invoices");
    expect(planBranch({ id: "1", slug: "export", jira: bad } as Intent), bad).toBe("plan/1-export");
  }
});
