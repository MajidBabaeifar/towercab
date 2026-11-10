// The chat's connections to the rest of Towercab (TG-2, TG-8): the page's actions and the page's data, read
// from the same code the page uses. Nothing here gives Telegram an action of its own.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { ownerForge } from "../github/forge.ts";
import type { Clock, Host } from "../handlers.ts";
import type { Home } from "../home.ts";
import type { IntentStore } from "../intents/types.ts";
import type { Loop } from "../loop.ts";
import { type Mission, unfinishedFor } from "../mission.ts";
import type { Telegram } from "../telegram.ts";
import { createActions } from "../ui/actions.ts";
import { inbox } from "../ui/inbox.ts";
import { proposedSection } from "../ui/proposed.ts";
import { currentPr, queue, type Snap, shipWords, snapshot, type Wait, waitsOf } from "../ui/state.ts";
import type { Card, ProposedCard } from "../ui/view.ts";
import { sourcesOf } from "../ui/wire.ts";
import { buildTrack, trackIndex } from "./card.ts";
import type { CardItem } from "./cards.ts";
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
    people: card.people ?? null,
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
  /** TG-16, TG-17: one mission as its card shows it, with the wait whose buttons it carries. */
  const cardOf = (
    snap: Snap,
    m: Mission,
    wait: Wait | undefined,
    pr: { github: string; number: number } | null,
  ): CardItem => {
    const finished = m.stage === "done" || m.stage === "stopped" || m.stage === "unverified";
    const open = wait && !wait.card.done ? wait : undefined;
    const view = open ? viewOf(open.card, `${m.id}.${m.continued}`, m.head ?? "") : null;
    const visited = w.db
      .all<{ from_stage: string; to_stage: string }>(
        "SELECT from_stage, to_stage FROM transitions WHERE mission = ? ORDER BY id",
        m.id,
      )
      .map((t) => ({ from: t.from_stage, to: t.to_stage }));
    // A dropped mission stands where it was dropped from; a finished one is past every stage.
    const last = visited.at(-1);
    const at = m.stage === "stopped" ? trackIndex(last?.from ?? "", null) : trackIndex(m.stage, m.from_stage);
    const stops = visited
      .flatMap((t) => [trackIndex(t.from, null), trackIndex(t.to, null)])
      .filter((i) => i >= 0);
    const first = Math.min(at >= 0 ? at : 4, ...stops);
    const final = !finished
      ? null
      : m.stage === "done"
        ? "✅ done"
        : m.stage === "unverified"
          ? `⚠ unverified: ${m.why ?? "merged, not checked live"}`
          : m.why?.startsWith("replaced by")
            ? "↩️ started over"
            : "🗑 dropped";
    const repo = w.config.repos.get(m.repo)?.github;
    const link = pr ? src().prUrl(pr.github, pr.number) : m.pr && repo ? src().prUrl(repo, m.pr) : null;
    return {
      wait: view,
      view: {
        intent: m.intent,
        mission: m.id,
        title: snap.intents.get(m.intent)?.title ?? m.intent,
        repo: m.repo,
        track: buildTrack(at, first, m.stage === "done" || m.stage === "unverified"),
        status: wait?.card.done?.text ?? shipWords(m),
        ask: view?.ask ?? null,
        question: view?.question ?? false,
        onlyYou: view?.onlyYou ?? false,
        waitId: view?.waitId ?? null,
        final,
        link,
      },
    };
  };
  const cards = async (): Promise<CardItem[]> => {
    const s = src();
    const snap = await snapshot(s);
    const waitOf = new Map(
      waitsOf(s, snap)
        .filter((x) => x.mission)
        .map((x) => [x.mission!.id, x] as const),
    );
    const out: CardItem[] = snap.missions.map((m) =>
      cardOf(snap, m, waitOf.get(m.id), currentPr(m, w.config, w.store.github())),
    );
    // An ended mission's card is closed once; a recent unverified one gets its card (TG-21).
    const ended = w.db.all<Mission>(
      `SELECT * FROM missions m WHERE m.stage IN ('done', 'stopped', 'unverified') AND (
         EXISTS (SELECT 1 FROM tg_cards c WHERE c.mission = m.id AND c.final = 0)
         OR (m.stage = 'unverified' AND m.finished > ?))`,
      w.clock.now() - 6 * 3600,
    );
    for (const m of ended) out.push(cardOf(snap, m, undefined, null));
    return out;
  };
  const data: ChatData = {
    cards,
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
