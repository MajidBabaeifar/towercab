// UI-211: the cards that report a repo Towercab can't reach show how to install the App.

import { afterEach, expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { missionCard, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});

const HELP = {
  app: "Towercab Bot",
  url: "https://github.com/apps/towercab/installations/new",
  steps: ["Open https://github.com/apps/towercab/installations/new to install “Towercab Bot”."],
};
const MISSING = "Towercab can't reach me/web: the GitHub App isn't installed on me/web";

function fixture(): Fixture {
  const f = buildFixture({ now: NOW });
  open.push(f);
  f.sources.installHelp = (github) => (github === "me/web" ? HELP : null);
  return f;
}

const blockedWith = (f: Fixture, why: string): Mission => ({
  ...f.sources.db.get<Mission>("SELECT * FROM missions LIMIT 1")!,
  stage: "blocked",
  from_stage: "verify",
  waiting: "checks red",
  why,
});

test("ui: a failed add problem shows the install steps", async () => {
  const f = fixture();
  f.sources.problems = () => [
    {
      title: "Towercab couldn't add the repo web (me/web)",
      detail: "Towercab couldn't clone me/web: the GitHub App isn't installed on me/web",
      fix: "Fix what the message says, then add the repo again.",
    },
  ];
  const o = await overview(f.sources);
  const p = o.problems.find((x) => x.title.includes("couldn't add the repo"))!;
  expect(p.installHelp).toEqual(HELP);
});

test("ui: an intent card with the missing install shows the steps", () => {
  const f = fixture();
  const card = missionCard(f.sources, blockedWith(f, MISSING), undefined, null, NOW);
  expect(card.installHelp).toEqual(HELP);
});

test("state: installHelp is set only for a missing install", async () => {
  const f = fixture();
  // Another error, and a missing install on a repo the sources can't help with, get none.
  expect(missionCard(f.sources, blockedWith(f, "npm test: 2 failing"), undefined, null, NOW).installHelp).toBeUndefined();
  const other = MISSING.replaceAll("me/web", "me/other");
  expect(missionCard(f.sources, blockedWith(f, other), undefined, null, NOW).installHelp).toBeUndefined();
  f.sources.problems = () => [{ title: "Towercab can't reach GitHub", detail: "HTTP 502", fix: "Wait." }];
  const o = await overview(f.sources);
  expect(o.problems.every((p) => p.installHelp === undefined)).toBe(true);
});
