// The observer on the page (UI-242, UI-243).

import { expect, test } from "vitest";
import { parseProposed } from "../../src/github/proposed.ts";
import { intentText } from "../../src/intents/store.ts";
import { proposalBody } from "../../src/observer/propose.ts";
import { observerView } from "../../src/ui/observer.ts";
import { proposedSection } from "../../src/ui/proposed.ts";
import type { UiSources } from "../../src/ui/state.ts";
import { finding, ObsRig, proposedPr } from "../observer/rig.ts";

test("ui: the observer panel shows its last run, proposals and spend", async () => {
  const r = new ObsRig();
  r.child([finding()], 0.45);
  await r.run(r.observer());
  const v = observerView({ db: r.db, config: r.config, clock: r.clock });
  expect(v.enabled).toBe(true);
  expect(v.lastRun).toMatchObject({ trigger: "daily", outcome: "done", proposals: 1, comments: 0 });
  expect(v.proposalsThisWeek).toBe(1);
  expect(v.maxPerWeek).toBe(3);
  expect(v.spentUsd).toBeCloseTo(0.45);
  expect(v.spentToday).toBe("$0.45");
  expect(v.cap).toBe("$3.00");
  expect(v.capReached).toBe(false);
  expect(v.lastReport).toBe("2026-11-09");
});

test("ui: the observer panel is hidden when off", () => {
  const r = new ObsRig({ enabled: false });
  const v = observerView({ db: r.db, config: r.config, clock: r.clock });
  expect(v.enabled).toBe(false);
  expect(v.lastRun).toBeNull();
});

test("ui: an observer proposal is tagged and shows its evidence", () => {
  const r = new ObsRig();
  const f = finding();
  const text = intentText(
    { repo: "web", title: f.title, u: 3, i: 4, a: 3, source: "observer", body: proposalBody(r.config, f) },
    new Date(r.clock.now() * 1000),
  );
  const parsed = parseProposed(text);
  if (!("intent" in parsed)) throw new Error(parsed.error);
  expect(parsed.intent.source).toBe("observer");
  expect(parsed.intent.observer?.evidence).toContain("`i-1`: failed twice");
  expect(parsed.intent.observer?.gain).toBe("About 2 fewer repairs per intent.");

  const pr = { ...proposedPr(21, finding().title), intent: parsed.intent };
  const other = proposedPr(22, "Something the owner wrote", "me");
  const src = {
    config: r.config,
    clock: r.clock,
    running: true,
    proposed: () => ({ list: [pr, other], error: null, failedAt: null }),
  } as unknown as UiSources;
  const cards = proposedSection(src).cards;
  const card = cards.find((c) => c.pr === 21)!;
  expect(card.observer).toBe(true);
  expect(card.observerNote?.evidence).toContain("`i-2`: failed three times");
  expect(card.observerNote?.gain).toContain("fewer repairs");
  // An intent from anyone else carries neither.
  const mine = cards.find((c) => c.pr === 22)!;
  expect(mine.observer).toBeUndefined();
  expect(mine.observerNote).toBeUndefined();
});
