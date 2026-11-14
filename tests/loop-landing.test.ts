// LOOP-79, LOOP-80: the parts of one intent freeze their repos together, merge in the plan's order and
// are checked live; the freeze lifts only then, and held merges of other intents go on.

import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { insertCommand } from "../src/commands.ts";
import { freezes, frozenBy, takeFreeze } from "../src/freeze.ts";
import { insertMission, type Mission } from "../src/mission.ts";
import { partsOf } from "../src/parts.ts";
import { landingOf } from "../src/queue.ts";
import { happy, intent, intents, PLAN, reply, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";

let p: Pipe;
let holder: Mission;
let other: Mission;
const merged: string[] = [];
/** The code PRs of the parts that merged, by repo, in the order they merged. */
const landed = () => {
  const mine = new Map(partsOf(main()).map((x) => [`owner/${x.repo}#${x.pr}`, x.repo]));
  return merged.filter((k) => mine.has(k)).map((k) => mine.get(k)!);
};

const PARTS = {
  ...PLAN,
  repos: [
    { repo: "infra", change: "Accept the new setting.", waits_on: [], safe_alone: "Nothing reads it yet." },
    { repo: "web", change: "Send the setting.", waits_on: ["infra"], safe_alone: "Infra accepts it." },
  ],
};

const outbox = () => p.db.all<{ text: string; mission: number | null }>("SELECT text, mission FROM outbox");

beforeAll(async () => {
  p = new Pipe(
    TARGET,
    {
      ...intents(intent({ a: 5, extra: "repos: [infra]\n" })),
      ...intents(intent({ title: "Held", repo: "infra", a: 1 }), "intents/261001-0001-held"),
      ...intents(intent({ title: "Other", a: 1 }), "intents/261001-0002-other"),
    },
    { keep: true },
  );
  p.bares.infra = p.bareRepo(TARGET);
  appendFileSync(p.gitconfig, `[url "${p.bares.infra}"]\n\tinsteadOf = https://github.com/owner/infra.git\n`);
  happy(p);
  p.respond.plan = reply(PARTS);
  const mergePr = p.mergePr.bind(p);
  p.mergePr = (pr) => {
    merged.push(`${pr.repo}#${pr.number}`);
    mergePr(pr);
  };
  await p.start({ repos: { web: { github: "owner/web" }, infra: { github: "owner/infra" } } });
  const now = p.clock.now();
  // Another intent holds the freeze of both repos, and a third waits at its merge in `web`.
  holder = insertMission(
    p.db,
    { intent: "261001-0001", slug: "held", repo: "infra", model: "opus", a: 3 },
    now,
  );
  other = insertMission(
    p.db,
    { intent: "261001-0002", slug: "other", repo: "web", model: "opus", a: 3 },
    now,
  );
  p.db.run("UPDATE missions SET stage = 'merge', step = '' WHERE id = ?", other.id);
  expect(takeFreeze(p.db, holder.id, ["infra", "web"], now)).toEqual({ ok: true });
}, 30_000);

afterAll(() => p.cleanup());

const main = () => p.mission()!;

test("loop: a held freeze makes the mission wait at the gate", async () => {
  await p.until(() => main().stage === "merge" && partsOf(main()).every((x) => x.atGate), 400);
  await p.until(() => (main().why ?? "").startsWith("waiting for the freeze"), 5);
  expect(main().why).toBe("waiting for the freeze of infra");
  // None of its repos was frozen by it, and nothing merged.
  expect(freezes(p.db).map((f) => f.mission)).toEqual([holder.id, holder.id]);
  expect(landed()).toEqual([]);
});

test("loop: other intents work up to the merge while frozen", async () => {
  await p.until(() => false, 3);
  // Its merge waits for the freeze of its repo; nothing else of it is stopped.
  expect(p.mission(other.id)!.stage).toBe("merge");
  expect(landingOf(p.mission(other.id)!)).toBeNull();
  expect(landed()).toEqual([]);
});

test("loop: a failed merge stops the ones after it", async () => {
  // A conflict on the first part stops the landing at that part: web is not merged.
  // The first freeze lifts (its intent ends), so the held mission takes both repos and starts to merge.
  p.db.run("UPDATE missions SET stage = 'stopped', finished = ? WHERE id = ?", p.clock.now(), holder.id);
  const infra = partsOf(main()).find((x) => x.repo === "infra")!;
  p.prNo("infra", infra.pr!).mergeStates.push("DIRTY");
  await p.untilStage("blocked", 30);
  expect(main().waiting).toBe("merge failed");
  expect(frozenBy(p.db, "web")).toBe(main().id);
  expect(landed()).toEqual([]);
  expect(partsOf(main()).map((x) => x.merged)).toEqual([false, false]);
  insertCommand(
    p.db,
    { name: "answer", arg: main().intent, text: "try again", source: "cli" },
    p.clock.now(),
  );
  await p.until(() => partsOf(main()).some((x) => x.merged), 30);
  expect(landed()[0]).toBe("infra");
});

test("loop: held merges continue after the freeze", () => {
  // The merge that waited for the first freeze started once it lifted.
  expect(landingOf(p.mission(other.id)!)).not.toBeNull();
});

test("loop: the owner is told when a freeze starts and lifts", async () => {
  await p.untilStage("done", 60);
  const texts = outbox().map((o) => o.text);
  const start = texts.findIndex((t) => t.startsWith("Merges are frozen in infra, web"));
  const lift = texts.findIndex((t) => t.startsWith(`Merges are unfrozen in infra, web (${main().intent}`));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(lift).toBeGreaterThan(start);
});

test("loop: parts merge in the plan's order", async () => {
  expect(landed()).toEqual(["infra", "web"]);
});

test("loop: a part without a live block counts as ok", () => {
  expect(partsOf(main()).map((x) => [x.repo, x.merged, x.stage, x.data?.skipped])).toEqual([
    ["infra", true, "shipped", true],
    ["web", true, "shipped", true],
  ]);
});

test("loop: the freeze lifts when every part is checked live", () => {
  expect(main().stage).toBe("done");
  expect(freezes(p.db).filter((f) => f.mission === main().id)).toEqual([]);
  expect(frozenBy(p.db, "infra")).toBeNull();
});

test("loop: a freeze writes nothing to GitHub", () => {
  for (const pr of p.prs) {
    expect(pr.body).not.toMatch(/freez/i);
    expect(pr.comments.map((c) => c.body).join("\n")).not.toMatch(/freez/i);
  }
});
