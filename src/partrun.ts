// LOOP-78: a part of a multi-repo mission runs through the same stage handlers as a single mission. The
// part is laid over the mission's row as a `Mission` (`project`), the handler works on that, and what it
// reports is applied to the part (`applyPart`), never to the mission, which moves only through `apply`.

import type { SqlValue } from "./db.ts";
import type { Ctx } from "./handlers.ts";
import {
  type ApplyCtx,
  apply,
  type Event,
  next,
  type Outcome,
  oneLine,
  type Stage,
  waitKey,
  waitMessage,
} from "./machine.ts";
import { dataOf, getMission, type Mission } from "./mission.ts";
import { allAtGate, inLanding, inPartStages, type PartState, partsOf, rollbackSet } from "./parts.ts";
import { shipFacts } from "./steps.ts";

/** The columns a part keeps as fields of its own; the rest of `Outcome.set` goes to its `cols`. */
const OWN: Record<string, keyof PartState> = { step: "step", pr: "pr", head: "head", branch: "branch" };

/** The part as a mission: the mission's row with the part's repo, PR, head, branch, checkout and stage on it. */
export function project(m: Mission, p: PartState): Mission {
  const { parts: _parts, ...shared } = dataOf(m);
  const data = { ...shared, ...(p.data ?? {}), part: p.repo };
  return {
    ...m,
    ...(p.cols as Partial<Mission> | undefined),
    repo: p.repo,
    stage: p.stage as Stage,
    step: p.step,
    pr: p.pr,
    head: p.head,
    branch: p.branch,
    checkout: p.checkout,
    waiting: p.waiting,
    data: JSON.stringify(data),
  };
}

/** Write one part of the mission in the caller's transaction; the other parts are read fresh. */
function writePart(
  cx: Pick<ApplyCtx, "db" | "now">,
  id: number,
  repo: string,
  patch: (p: PartState) => PartState,
) {
  const cur = getMission(cx.db, id);
  if (!cur) throw new Error(`mission ${id} is gone`);
  const d = dataOf(cur);
  const parts = partsOf(cur).map((p) => (p.repo === repo ? patch(p) : p));
  cx.db.run(
    "UPDATE missions SET data = ?, updated = ? WHERE id = ?",
    JSON.stringify({ ...d, parts }),
    cx.now,
    id,
  );
}

/** Lay a handler's column and data writes on a part. */
function lay(p: PartState, set: Record<string, SqlValue>, data?: Record<string, unknown>): PartState {
  const out: PartState = { ...p, cols: { ...(p.cols ?? {}) }, data: { ...(p.data ?? {}) } };
  for (const [k, v] of Object.entries(set)) {
    const own = OWN[k];
    if (own) (out as unknown as Record<string, unknown>)[own] = v;
    else out.cols![k] = v;
  }
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined) delete out.data![k];
    else out.data![k] = v;
  }
  return out;
}

/** The `Ctx` a handler gets for a part: `record` stores the step and its ids on the part, not the mission. */
export function partCtx(cx: Ctx, repo: string): Ctx {
  return {
    ...cx,
    record: (m, step, set = {}, data) => {
      const now = cx.clock.now();
      cx.db.tx(() => {
        writePart({ db: cx.db, now }, m.id, repo, (p) => {
          const same = step === p.step;
          const cols = same ? set : { ...set, unclean: 0, retries: 0, step_secs: 0 };
          const patch = same ? data : { ...data, launched: undefined };
          return lay({ ...p, step }, cols, patch);
        });
      });
      const fresh = getMission(cx.db, m.id)!;
      return project(fresh, partsOf(fresh).find((x) => x.repo === repo)!);
    },
  };
}

/** The repos a part's stage may take it to by itself: `build` to `gate` (LOOP-78). */
const OWN_STAGES = new Set<string>(["build", "verify", "proof", "publish", "ci", "review", "gate"]);

/**
 * A part waits for the owner: the mission shows it as its own blocked wait (so the owner's commands act on it),
 * and the other parts go on. A second part's wait is another message of the same wait.
 */
function ask(cx: ApplyCtx, cur: Mission, repo: string, waiting: string, why: string | null): void {
  if (cur.stage !== "blocked") {
    apply(cx, cur, { event: "wait", waiting, why: why ?? undefined });
    return;
  }
  cx.db.run(
    "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, ?, ?, ?)",
    `${cur.id}:${repo}:${waitKey(waiting)}:${cur.continued}`,
    cur.id,
    waitMessage(waiting, cx.subject({ ...cur, repo }), why),
    cx.now,
  );
}

/**
 * LOOP-80: what a handler reported about the part the landing works on. The mission waits for the owner as
 * a whole (a failed merge stops the sequence at that part); a part that merged or shipped is written on its
 * part, and the mission moves through `apply` when the last part is through. Null: nothing special, the
 * generic outcomes (again, backoff, cool, recover) apply.
 */
function landed(cx: ApplyCtx, cur: Mission, part: PartState, o: Outcome): Mission | null {
  const set = o.set ?? {};
  const upd = (f: (p: PartState) => PartState) => writePart(cx, cur.id, part.repo, f);
  const at = () => getMission(cx.db, cur.id)!;
  const ask = (waiting: string, why: string | undefined) => apply(cx, at(), { event: "wait", waiting, why });
  if (o.event === "wait") return ask(o.waiting!, o.why);
  if (o.event === "closed" || o.event === "intent_removed") return apply(cx, cur, o);
  if (cur.stage === "merge") {
    if (o.event === "code_merged") {
      upd((p) => lay({ ...p, merged: true, step: "", stage: "gate", waiting: null }, set, o.data));
      if (partsOf(at()).every((p) => p.merged)) {
        apply(cx, at(), { event: "code_merged", why: "every part is merged" });
        for (const p of partsOf(at()))
          writePart(cx, cur.id, p.repo, (x) => ({ ...x, stage: "deploy", step: "" }));
      }
      return at();
    }
    if (o.event === "head_moved" || o.event === "conflict") {
      return ask("merge failed", o.why ?? `the pull request of ${part.repo} changed after the gate`);
    }
    return null;
  }
  if (cur.stage === "deploy" || cur.stage === "e2e") {
    for (const [k, v] of Object.entries(o.meta ?? {})) cx.db.setMeta(k, v);
    const done = (skipped: boolean) => {
      upd((p) => lay({ ...p, stage: "shipped", step: "" }, set, { ...(o.data ?? {}), skipped }));
      const left = partsOf(at()).some((p) => p.stage === "deploy" || p.stage === "e2e");
      if (left) return at();
      // Every part is through: the mission ends the way a single one does (SHIP-21 when none had a live block).
      if (partsOf(at()).every((p) => p.data?.skipped === true)) {
        const none = partsOf(at()).every((p) => String(p.data?.liveNoneWhy ?? "").trim() !== "");
        const why = none ? { liveNoneWhy: String(partsOf(at())[0]!.data!.liveNoneWhy) } : undefined;
        return apply(cx, at(), { event: "skip", ...(why ? { data: why } : {}) });
      }
      apply(cx, at(), { event: "ok", why: "every part is live" });
      return apply(cx, at(), { event: "ok", why: "every part is live" });
    };
    if (o.event === "skip") return done(true);
    if (o.event === "ok") {
      if (part.stage === "deploy") {
        upd((p) => lay({ ...p, stage: "e2e", step: "" }, set, o.data));
        return at();
      }
      return done(false);
    }
    if (o.event === "red") {
      // LOOP-82: this part and every merged part after it go back, last landed first; the parts before it
      // stay merged and live, and parts not merged are left alone.
      upd((p) => lay(p, set, o.data));
      for (const r of rollbackSet(partsOf(at()), part.repo)) {
        writePart(cx, cur.id, r.repo, (p) => ({
          ...p,
          stage: "rollback",
          step: "",
          waiting: null,
          data: {
            ...(p.data ?? {}),
            ship: p.data?.ship ?? { merges: [String(p.cols?.merge_sha)], fixes: 0 },
          },
        }));
      }
      return apply(cx, at(), { event: "red", why: o.why });
    }
  }
  if (cur.stage === "rollback") {
    if (o.event === "ok") {
      // The part is back on the last good version: it is built again, with a new PR (SHIP-10).
      upd((p) =>
        lay({ ...p, stage: "build", step: "", merged: false, atGate: false, waiting: null }, set, {
          ...(o.data ?? {}),
          skipped: undefined,
          needsApproval: undefined,
        }),
      );
      if (!partsOf(at()).some((p) => p.stage === "rollback")) {
        return apply(cx, at(), { event: "ok", why: "every rolled-back part is back" });
      }
      return at();
    }
    if (o.event === "revert") {
      return ask("rollback failed", o.why ?? `${part.repo}: the fixes didn't hold; revert it by hand`);
    }
  }
  return null;
}

/**
 * LOOP-78: apply what a handler reported about one part, in one transaction. The part moves with the
 * transition table of the stages `build` to `gate` (`next`); a part that passes the gate stays there until
 * every part has, and then the mission itself leaves the parts through `apply` (`parts_gated`).
 */
export function applyPart(cx: ApplyCtx, m: Mission, repo: string, o: Outcome): Mission {
  return cx.db.tx(() => {
    const cur = getMission(cx.db, m.id);
    const landing = !!cur && inLanding(cur);
    if (!cur || !(landing || inPartStages(cur))) return cur ?? m;
    const part = partsOf(cur).find((p) => p.repo === repo);
    if (!part || (!landing && (part.atGate || part.merged))) return cur;
    if (landing) {
      const r = landed(cx, cur, part, o);
      if (r) return r;
    }
    const n = next(
      landing ? (cur.stage as Stage) : (part.stage as Stage),
      o.event as Event,
      null,
      shipFacts(dataOf(cur)),
    );
    const set = o.set ?? {};
    const upd = (f: (p: PartState) => PartState) => writePart(cx, cur.id, repo, f);
    switch (n.kind) {
      case "go": {
        if (n.to === "merge") {
          // The part passed the gate: it waits there for the others.
          upd((p) => lay({ ...p, atGate: true, waiting: null, step: "" }, set, o.data));
        } else if (OWN_STAGES.has(n.to)) {
          upd((p) =>
            lay(
              { ...p, stage: n.to as PartState["stage"], step: "", waiting: null },
              { ...set, retry_at: null },
              {
                ...(o.data ?? {}),
                launched: undefined,
              },
            ),
          );
        } else {
          return cur;
        }
        break;
      }
      case "wait": {
        if (!o.waiting) throw new Error("bug: wait without a waiting text");
        // The owner's approval to merge is asked for the intent as a whole, when every part is at the gate.
        if (part.stage === "gate" && o.waiting === "review and merge PR") {
          upd((p) =>
            lay({ ...p, atGate: true, waiting: null }, set, { ...(o.data ?? {}), needsApproval: true }),
          );
          break;
        }
        upd((p) => lay({ ...p, waiting: o.waiting! }, set, o.data));
        ask(cx, cur, repo, o.waiting, o.why ?? null);
        break;
      }
      case "again":
        upd((p) => lay(p, { ...set, busy: 0 }, o.data));
        break;
      case "backoff": {
        const retries = Number(part.cols?.retries ?? 0) + 1;
        const after = (cx.backoff ?? ((r: number) => [30, 60, 120, 240, 300][Math.min(r, 4)]!))(retries - 1);
        upd((p) => lay(p, { ...set, retries, retry_at: cx.now + after, busy: 0 }, o.data));
        break;
      }
      case "cool": {
        if (!o.limit) throw new Error("bug: limit without a limit");
        const { model, until, backoffs, text } = o.limit;
        cx.db.setMeta(`cooldown:${model}`, JSON.stringify({ until, backoffs, text, since: cx.now }));
        upd((p) => lay(p, { ...set, limit_model: model, busy: 0 }, o.data));
        break;
      }
      case "recover": {
        const unclean = Number(part.cols?.unclean ?? 0) + 1;
        if (unclean >= 3) {
          upd((p) => lay({ ...p, waiting: `crashed at ${part.stage}` }, { ...set, unclean: 0 }, o.data));
          ask(cx, cur, repo, `crashed at ${part.stage}`, o.why ?? null);
        } else {
          upd((p) => lay(p, { ...set, unclean, busy: 0 }, o.data));
        }
        break;
      }
      default:
        return cur;
    }
    cx.log?.(
      `${cur.intent} part ${repo} ${part.stage} (${o.event}${o.why ? `: ${oneLine(o.why, 120)}` : ""})`,
    );
    const after = getMission(cx.db, cur.id)!;
    if (!landing && allAtGate(partsOf(after)))
      return apply(cx, after, { event: "parts_gated", why: "every part passed the gate" });
    return after;
  });
}

/** Store columns and data on one part outside an outcome (a run that started, a run's time), in one transaction. */
export function patchPart(
  cx: Pick<ApplyCtx, "db" | "now">,
  id: number,
  repo: string,
  set: Record<string, SqlValue>,
  data?: Record<string, unknown>,
): void {
  cx.db.tx(() => writePart(cx, id, repo, (p) => lay(p, set, data)));
}

/**
 * LOOP-78: the cap of the whole intent is reached. Every part still working stops at its next step, and the
 * owner is asked once, not once per part.
 */
export function stopForCap(cx: ApplyCtx, m: Mission, why: string): Mission {
  return cx.db.tx(() => {
    const cur = getMission(cx.db, m.id);
    if (!cur || !inPartStages(cur)) return cur ?? m;
    const live = partsOf(cur).filter((p) => !p.atGate && !p.merged && p.waiting === null);
    if (live.length === 0) return cur;
    for (const p of live) writePart(cx, cur.id, p.repo, (x) => ({ ...x, waiting: "worker budget" }));
    ask(cx, getMission(cx.db, cur.id)!, live[0]!.repo, "worker budget", why);
    return getMission(cx.db, cur.id)!;
  });
}
