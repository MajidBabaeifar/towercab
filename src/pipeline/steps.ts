// The owner's steps at work (SHIP-17..19, SHIP-22): keep the mission's copy of the plan's steps fresh,
// hold the gate for the steps needed before the merge, wait at `steps` for the ones needed after it, and
// write ticks back to `plan.md`.

import type { Ctx, Handler } from "../handlers.ts";
import { ok, wait } from "../machine.ts";
import { getMission, type Mission, patchData } from "../mission.ts";
import { checklist, parseDelivery, parseNoneLive, unticked, withDelivery, withSteps } from "../steps.ts";
import { data, intentOf, stepsFromPlan } from "./common.ts";
import { commitToIntents } from "./plan.ts";

/** How often the `steps` stage looks for ticks, seconds: a pass. */
const STEPS_POLL = 5;

/** The mission with its steps read again from the merged `plan.md` (the file is the record, SHIP-17). */
export async function refreshSteps(cx: Ctx, m: Mission): Promise<Mission> {
  const patch = await stepsFromPlan(cx, m);
  if (!("steps" in patch)) return m;
  const d = data(m);
  const same =
    JSON.stringify(d.steps ?? null) === JSON.stringify(patch.steps ?? null) &&
    (d.liveNoneWhy ?? "") === (patch.liveNoneWhy ?? "") &&
    d.stepsDirty === patch.stepsDirty;
  return same ? m : cx.record(m, m.step, {}, patch);
}

/** SHIP-18: the gate's hold, or null when no step is needed before the merge. */
export async function stepsBeforeMerge(cx: Ctx, m: Mission): Promise<{ m: Mission; why: string | null }> {
  const fresh = await refreshSteps(cx, m);
  const steps = data(fresh).steps;
  const open = unticked(steps, "before");
  return { m: fresh, why: open.length ? checklist(steps ?? [], "before") : null };
}

/** The mission's steps written to `plan.md` on the intents repo's `main` (SHIP-22); the ticks then stand. */
export async function writeTicks(cx: Ctx, m: Mission): Promise<void> {
  const d = data(m);
  if (d.stepsDirty === undefined || !d.steps) return;
  const intent = await intentOf(cx, m);
  const path = `${intent.dir}/plan.md`;
  const md = await cx.store.readFile(path);
  if (md === null) return;
  const text = withSteps(md, d.steps, parseNoneLive(md));
  // Written even when unchanged: it is how a push that failed earlier is retried.
  await commitToIntents(
    cx,
    "main",
    "origin/main",
    { [path]: text },
    `towercab: ticked step ${d.stepsDirty} of ${m.intent}`,
  );
  // A tick made while the push was awaited isn't in the file: clear the mark only if the steps are
  // still the ones written, in one transaction, so that tick is written on the next pass.
  cx.db.tx(() => {
    const cur = getMission(cx.db, m.id);
    if (!cur) return;
    if (JSON.stringify(data(cur).steps) === JSON.stringify(d.steps))
      patchData(cx.db, cur, { stepsDirty: undefined }, cx.clock.now());
  });
}

/** PIP-113: a mission switched to steps says so in the plan file, which is the record. */
async function syncDelivery(cx: Ctx, m: Mission): Promise<void> {
  const intent = await intentOf(cx, m);
  const path = `${intent.dir}/plan.md`;
  const md = await cx.store.readFile(path);
  if (md === null || parseDelivery(md) === "steps") return;
  // The steps are written as the mission has them (all "after"), so the file and the database agree.
  const steps = data(m).steps;
  const text = withDelivery(md, "steps");
  await commitToIntents(
    cx,
    "main",
    "origin/main",
    { [path]: steps?.length ? withSteps(text, steps, parseNoneLive(md)) : text },
    `towercab: plan changed ${m.intent}`,
  );
}

/** SHIP-19: wait for the owner's steps after the merge. */
export const stepsHandler: Handler = {
  async step(cx, m) {
    if (data(m).delivery === "steps") await syncDelivery(cx, m);
    const fresh = await refreshSteps(cx, m);
    const steps = data(fresh).steps ?? [];
    if (unticked(steps, "after").length === 0) return { done: ok({ why: "your steps are done" }) };
    if (fresh.waiting !== "your steps") return { done: wait("your steps", checklist(steps, "after")) };
    return { poll: STEPS_POLL };
  },
  async finish() {
    return { poll: 0 };
  },
};
