// The shadow on the page (UI-237): `GET /api/shadow`, the panel's data.

import { actionSentence, costToday, pendingActions, recentActions } from "../shadow/store.ts";
import { money, type UiSources, when } from "./state.ts";
import type { ShadowView } from "./view.ts";

/** The last 10 actions with links, what waits for the owner's yes, and today's spend against the cap. */
export function shadowView(src: Pick<UiSources, "db" | "config" | "clock" | "prUrl">): ShadowView {
  const { db, config } = src;
  const now = src.clock.now();
  const spent = costToday(db, now);
  const cap = config.shadow.dailyBudgetUsd;
  return {
    enabled: config.shadow.enabled,
    actions: recentActions(db, 10).map((a) => {
      const repo = db.get<{ repo: string }>(
        "SELECT repo FROM missions WHERE intent = ? ORDER BY id DESC LIMIT 1",
        a.intent,
      )?.repo;
      const github = repo ? config.repos.get(repo)?.github : undefined;
      return {
        id: a.id,
        at: when(a.at, now),
        text: actionSentence(a),
        outcome: a.outcome === "held" || a.outcome === "refused" ? a.outcome : "done",
        intent: a.intent || null,
        pr: a.pr && github ? { number: a.pr, url: src.prUrl(github, a.pr) } : null,
      };
    }),
    pending: pendingActions(db).map((p) => ({ action: p.action, intent: p.intent })),
    spentToday: money(spent),
    cap: money(cap),
    spentUsd: spent,
    capUsd: cap,
  };
}
