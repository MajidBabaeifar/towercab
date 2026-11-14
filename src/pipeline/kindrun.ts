// INT-77: the kind agent's run at the start of the design stage, and what its answer does.

import type { ChildEnd, Ctx, Progress } from "../handlers.ts";
import { isKind } from "../kind.ts";
import type { Mission } from "../mission.ts";
import { data, ended, intentOf, repoFiles, spawnRun } from "./common.ts";
import { intentData, render } from "./prompts.ts";
import { parseResult } from "./schemas.ts";

/** Whether the mission still needs its kind: the intent sets none and none was kept. */
export async function needsKind(cx: Ctx, m: Mission): Promise<boolean> {
  if (isKind(data(m).kind)) return false;
  return !isKind((await intentOf(cx, m)).kind);
}

/** Ask the agent (no tools, the intent as data) what kind of work this is. */
export async function kindStep(cx: Ctx, m: Mission): Promise<Progress> {
  const intent = await intentOf(cx, m);
  return spawnRun(cx, m, {
    kind: "kind",
    step: "kind",
    agent: "kind",
    prompt: render("kind", { intent: intentData(intent.text) }),
    files: await repoFiles(cx, m),
    intent,
  });
}

const UNSURE = "Towercab could not tell what kind of work this is, so it uses the full path.";

/** PIP-228: the answer is kept in the mission; a lighter kind skips on to the plan. A failed run counts as `feature`. */
export function kindFinish(cx: Ctx, m: Mission, end: ChildEnd): Progress {
  const r = ended(cx, m, "kind", end, (v) => parseResult("kind", v));
  if (!r.ok && "done" in r.progress && r.progress.done.event === "limit") return r.progress;
  if (!r.ok) cx.log(`${m.intent}: the kind agent gave no answer; counting it as feature`);
  const { kind, why } = r.ok ? r.value : { kind: "feature" as const, why: UNSURE };
  const d = { kind, kindWhy: why, kindBy: "guess" as const };
  if (kind === "bugfix" || kind === "refactor" || kind === "infra")
    return { done: { event: "kind_routed", why, data: d } };
  // A feature or a spec-only change carries on with its design.
  cx.record(m, "", {}, d);
  return { poll: 0 };
}
