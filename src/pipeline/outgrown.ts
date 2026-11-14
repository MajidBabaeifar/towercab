// PIP-231: a lighter kind whose change goes beyond its path becomes one question to the owner, never a silent change.

import type { Ctx, Progress } from "../handlers.ts";
import { fixedRow, outgrown, type WorkKind } from "../kind.ts";
import type { Outcome } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { ask, coGit, data } from "./common.ts";

const WHY_FEATURE = "the owner moved this to the full path";

/** The first reason the build's spec changes go beyond a lighter kind's path, or null. Code decides, not the agent. */
async function reason(cx: Ctx, m: Mission, kind: WorkKind): Promise<string | null> {
  const base = `refs/remotes/origin/${cx.repo(m).base}`;
  const names = (await coGit(cx, m, ["diff", "--name-only", `${base}...HEAD`, "--", "specs"]))
    .split("\n")
    .filter(Boolean);
  const fixId = fixedRow(data(m).plan?.md ?? "");
  for (const f of names) {
    const before = await coGit(cx, m, ["show", `${base}:${f}`]).catch(() => "");
    const after = await coGit(cx, m, ["show", `HEAD:${f}`]).catch(() => "");
    const why = outgrown(kind, f, before, after, fixId);
    if (why) return why;
  }
  return null;
}

/**
 * Before the code PR: null when the change stays within its kind's path; else the question (first time), or the
 * move to the full path / the change dropped (after the owner's answer).
 */
export async function checkOutgrown(cx: Ctx, m: Mission, kind: WorkKind): Promise<Progress | null> {
  if (kind === "feature" || kind === "spec-only") return null;
  const d = data(m);
  if (d.kindAsk) {
    const text = (d.answer ?? "").toLowerCase();
    const full = /\bfeature\b|full path/.test(text) && !/\bkeep\b/.test(text);
    if (full) {
      await cx.store.update(m.intent, "kind: feature", (e) => e.setField("kind", "feature"));
      return {
        done: {
          event: "kind_routed",
          why: WHY_FEATURE,
          data: {
            kind: "feature",
            kindBy: "owner",
            kindWhy: WHY_FEATURE,
            kindAsk: undefined,
            answer: undefined,
          },
        },
      };
    }
    // Keep the kind: the spec change is dropped, the rest of the work stays.
    await coGit(cx, m, ["checkout", `refs/remotes/origin/${cx.repo(m).base}`, "--", "specs"]);
    await coGit(cx, m, ["commit", "--allow-empty", "-q", "-m", "revert: drop the spec change"]).catch(
      () => "",
    );
    cx.record(m, m.step, {}, { kindAsk: undefined, answer: undefined, kindKept: true });
    return null;
  }
  if (d.kindKept) return null;
  const why = await reason(cx, m, kind);
  if (!why) return null;
  return { done: await askKindChange(cx, m, kind, why) };
}

/** PIP-231: the one question "Move this to the full path?". */
export async function askKindChange(cx: Ctx, m: Mission, kind: WorkKind, why: string): Promise<Outcome> {
  const o = await ask(
    cx,
    m,
    {
      context: `This is set up as ${kind === "infra" ? "an infrastructure change" : `a ${kind}`}, which does not allow all of this work: ${why}`,
      question: "Move this to the full path?",
      options: [
        {
          option: "feature",
          // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
          then: "The spec PR comes first and the work done so far stays in the branch; nothing merged is undone.",
          do: "continue",
        },
        {
          option: "keep",
          // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
          then: "The work carries on as it is, with the change dropped.",
          do: "continue",
        },
      ],
      recommendation: "feature, since the change goes beyond this kind of work.",
    },
    "answer the question",
  );
  return { ...o, data: { ...o.data, kindAsk: true, answer: undefined } };
}
