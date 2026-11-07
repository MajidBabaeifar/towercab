// The chat's connections to the rest of Towercab (TG-2, TG-8): the page's actions and the page's data, read
// from the same code the page uses. Nothing here gives Telegram an action of its own.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { ownerForge } from "../github/forge.ts";
import type { Clock, Host } from "../handlers.ts";
import type { Home } from "../home.ts";
import type { IntentStore } from "../intents/types.ts";
import type { Loop } from "../loop.ts";
import { unfinishedFor } from "../mission.ts";
import type { Telegram } from "../telegram.ts";
import { createActions } from "../ui/actions.ts";
import { inbox } from "../ui/inbox.ts";
import { proposedSection } from "../ui/proposed.ts";
import { currentPr, queue, snapshot, waitsOf } from "../ui/state.ts";
import type { Card, ProposedCard } from "../ui/view.ts";
import { sourcesOf } from "../ui/wire.ts";
import { Chat, type ChatData } from "./chat.ts";
import type { ProposalView, WaitView } from "./render.ts";

export interface ChatWorld {
  config: Config;
  home: Home;
  db: Db;
  clock: Clock;
  store: IntentStore;
  github: Host;
  log(line: string): void;
}

const proposalOf = (c: ProposedCard): ProposalView => ({
  pr: c.pr,
  head: c.head,
  title: c.title,
  repo: c.repo,
  url: c.prUrl,
});

/** The chat for `towercab run --watch`: `loop` is read when data is needed, not before. */
export function buildChat(w: ChatWorld, telegram: Telegram, loop: () => Loop): Chat {
  const src = () => sourcesOf(loop(), w.home);
  const actions = createActions({
    db: w.db,
    store: w.store,
    config: w.config,
    clock: w.clock,
    github: w.github,
    proposed: () => loop().proposedState().list,
  });
  const viewOf = (card: Card, id: string, head: string): WaitView => ({
    intent: card.intent,
    title: card.title,
    repo: card.repo,
    ask: card.ask,
    why: card.why,
    question: card.kind === "question" || (card.openPoints?.length ?? 0) > 0,
    actions: card.actions.filter(
      (a): a is "merge" | "retry" | "drop" => a === "merge" || a === "retry" || a === "drop",
    ),
    onlyYou: card.onlyYou === true,
    waitId: id,
    head,
    pr: card.pr,
    base: w.config.repos.get(card.repo)?.base ?? "main",
  });
  const waits = async (): Promise<WaitView[]> => {
    const s = src();
    return waitsOf(s, await snapshot(s))
      .filter((x) => x.mission && !x.card.done)
      .map((x) => viewOf(x.card, `${x.mission!.id}.${x.mission!.continued}`, x.mission!.head ?? ""));
  };
  const data: ChatData = {
    waits,
    proposals: async () => proposedSection(src()).cards.map(proposalOf),
    focus: async () => {
      const page = await inbox(src());
      const items = page.items.filter(
        (i) => i.snoozedUntil === null && (i.kind === "card" || i.kind === "proposed"),
      );
      const top = items[0];
      const more = Math.max(0, items.length - 1);
      if (top?.kind === "proposed" && top.proposed)
        return { wait: null, proposal: proposalOf(top.proposed), more };
      const wait = top ? ((await waits()).find((x) => x.intent === top.key) ?? null) : null;
      return { wait, proposal: null, more };
    },
    queue: async () => {
      const out: { title: string; repo: string; state: string }[] = [];
      for (const lane of (await queue(src())).lanes) {
        for (const r of lane.running) out.push({ title: r.title, repo: lane.repo, state: "running" });
        for (const q of lane.upNext)
          out.push({ title: q.title, repo: lane.repo, state: q.state.label.toLowerCase() });
        for (const q of lane.waiting)
          out.push({
            title: q.title,
            repo: lane.repo,
            state: q.reason ? `held back: ${q.reason}` : q.state.label.toLowerCase(),
          });
      }
      return out;
    },
    running: async () =>
      (await queue(src())).lanes.flatMap((l) =>
        l.running.map((r) => ({ intent: r.intent, title: r.title, step: r.step })),
      ),
    prHead: async (intent) => {
      const m = unfinishedFor(w.db, intent);
      const p = m ? currentPr(m, w.config, w.store.github()) : null;
      return p ? (await ownerForge(w.github.owner).prBrief(p.github, p.number)).head : null;
    },
  };
  return new Chat({ config: w.config, db: w.db, clock: w.clock, log: w.log, telegram, actions, data });
}
