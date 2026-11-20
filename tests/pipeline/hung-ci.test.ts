// A check that hangs past `ci_wait` is cancelled and rerun once per head; a second hang asks the owner
// (PIP-171).

import { expect, test } from "vitest";
import { checkRun, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const RUN = 300;
const hang = () => checkRun("test", "", RUN, "IN_PROGRESS");
const status = { __typename: "StatusContext", context: "ext/ci", state: "PENDING" };

/** Hangs until Towercab cancels it; then a cancelled run; after the rerun `afterRerun`. */
function hanging(p: Pipe, afterRerun: () => unknown) {
  return () => {
    if (p.reruns.length) return [afterRerun()];
    return [p.cancels.length ? checkRun("test", "CANCELLED", RUN) : hang()];
  };
}

async function flow(run: (p: Pipe) => Promise<void>): Promise<void> {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    await run(p);
  } finally {
    p.cleanup();
  }
}

/** Gives the code PR `checks` once it exists, and runs until `done`. */
async function onCodePr(p: Pipe, checks: () => unknown[], done: () => boolean): Promise<void> {
  await p.start();
  await p.until(() => {
    const code = p.prs.find((x) => x.head === `towercab/${ID}-${SLUG}`);
    if (code) code.checks = checks as never;
    return done();
  }, 150);
}

test(
  "pipeline: a hung Actions run is cancelled and rerun once",
  () =>
    flow(async (p) => {
      const checks = hanging(p, () => checkRun("test", "SUCCESS", RUN));
      await onCodePr(p, checks, () => p.reruns.length > 0);
      expect(p.cancels).toEqual([RUN]);
      expect(p.reruns).toEqual([RUN]);
      expect(p.forge.calls.filter((l) => /^(cancel|rerun) /.test(l))).toEqual([
        `cancel owner/web ${RUN}`,
        `rerun owner/web ${RUN}`,
      ]);
      const m = p.mission()!;
      // No repair was counted and the owner was not asked.
      expect(m.ci_repairs).toBe(0);
      expect(m.stage).not.toBe("blocked");
    }),
  120_000,
);

test(
  "pipeline: a rerun that hangs too waits for the owner",
  () =>
    flow(async (p) => {
      const checks = hanging(p, hang);
      await onCodePr(p, checks, () => p.mission()?.stage === "blocked");
      const m = p.mission()!;
      expect([m.stage, m.waiting]).toEqual(["blocked", "CI stuck"]);
      expect(m.why).toContain("hung twice");
      expect(p.cancels).toEqual([RUN]);
      expect(p.reruns).toEqual([RUN]);
      expect(m.ci_repairs).toBe(0);
    }),
  120_000,
);

test(
  "pipeline: a pending check that is not an Actions run is stuck at ci_wait",
  () =>
    flow(async (p) => {
      await onCodePr(
        p,
        () => [status],
        () => p.mission()?.stage === "blocked",
      );
      const m = p.mission()!;
      expect([m.stage, m.waiting]).toEqual(["blocked", "CI stuck"]);
      expect(p.cancels).toEqual([]);
      expect(p.reruns).toEqual([]);
    }),
  120_000,
);

test(
  "pipeline: a hung spec PR check is cancelled and rerun",
  () =>
    flow(async (p) => {
      const checks = hanging(p, hang);
      p.newPrChecks = (pr) => (pr.head.endsWith("-spec") ? (checks() as never) : []);
      await p.start();
      await p.until(() => p.mission()?.stage === "approval:spec", 150);
      const m = p.mission()!;
      // Cancelled and rerun once, then the second hang asks the owner.
      expect(p.cancels).toEqual([RUN]);
      expect(p.reruns).toEqual([RUN]);
      expect(m.waiting).toBe("approve spec");
      expect(m.why).toContain("hung twice");
      expect(p.forge.calls.some((l) => l.startsWith("merge "))).toBe(false);
    }),
  120_000,
);
