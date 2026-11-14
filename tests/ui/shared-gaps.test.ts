// UI-268..273: the warning colour, gaps most repos share, setup in plain words, and the stage map's path.

import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { board } from "../../src/ui/board.ts";
import { repos } from "../../src/ui/repos.ts";
import { stageMap } from "../../src/ui/state.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function many(): Fixture {
  const f = buildFixture({ now: NOW, readiness: true, many: true });
  cleanup.push(() => f.cleanup());
  return f;
}

const css = readFileSync(new URL("../../ui/src/styles.css", import.meta.url), "utf8");
const light = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

/** The first value of a custom property in `block`, as [r, g, b, alpha]. */
function colour(block: string, name: string): [number, number, number, number] {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`--${name} is not defined`);
  const v = m[1]!.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(v);
  if (!rgb) throw new Error(`--${name}: cannot read ${v}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
}

/** `top` drawn over `under` (alpha). */
const over = (top: number[], under: number[]) =>
  [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!));

const lum = (c: number[]) => {
  const [r, g, b] = c.map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const hue = (c: number[]) => {
  const [r, g, b] = c.map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

test("ui: warn and needs colours differ with enough contrast", () => {
  for (const block of [light, dark]) {
    const surface = colour(block, "surface");
    const warn = colour(block, "warn");
    const needs = colour(block, "needs");
    // The warning hue is far from the amber of "Needs you".
    const gap = Math.abs(hue(warn) - hue(needs));
    expect(Math.min(gap, 360 - gap)).toBeGreaterThan(40);
    // Its text reads on the page's surface and on its own tinted background.
    expect(contrast(warn, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warn, over(colour(block, "warn-bg"), surface))).toBeGreaterThanOrEqual(4.5);
  }
});

test("ui: a shared gap is summed up once on the repos page", async () => {
  const f = many();
  const page = await repos(f.sources, null);
  expect(page.shared).toEqual([{ item: "release", count: 5, total: 7, words: "no release job" }]);
  // A gap on fewer than three repos is not shared.
  expect(page.shared.map((g) => g.item)).not.toContain("deploy");
});

test("ui: the board sums up shared gaps in one line above the columns", async () => {
  const f = many();
  const b = await board(f.sources);
  // The same data as the Repos page, so the two lines count the same repos.
  expect(b.shared).toEqual((await repos(f.sources, null)).shared);
  const plain = buildFixture({ now: NOW });
  cleanup.push(() => plain.cleanup());
  expect((await board(plain.sources)).shared).toEqual([]);
});

test("ui: no badge for a repo missing only shared items", async () => {
  const f = many();
  const page = await repos(f.sources, null);
  const badge = (repo: string) => page.chips.find((c) => c.repo === repo)!.readiness;
  // tool and lib lack only the release job, which is shared.
  expect(badge("tool")).toBeUndefined();
  expect(badge("lib")).toBeUndefined();
  expect(page.all.find((s) => s.repo === "tool")?.readiness).toBeUndefined();
  // site also lacks a live check: the badge stays, naming only that.
  expect(badge("site")).toMatchObject({ label: "Not ready", missing: 1 });
  expect(badge("site")?.detail).toContain("live");
  expect(badge("site")?.detail).not.toContain("Release-please");
  // A repo whose new work is held keeps its badge.
  expect(badge("web")).toMatchObject({ blocks: true });
  const lane = (await board(f.sources)).repos.find((r) => r.repo === "tool");
  expect(lane?.readiness).toBeUndefined();
});

test("ui: setup gaps are plain words with the error under details", async () => {
  const f = many();
  const setup = (await repos(f.sources, "ops")).repo!.setup!;
  const settings = setup.items.find((i) => i.item === "settings")!;
  expect(settings.plain).toBe(
    "Towercab's GitHub App can't read this repo's workflow settings: give it the Actions permission",
  );
  expect(settings.raw).toContain("HTTP 403");
  expect(settings.plain).not.toContain("gh api");
  // A missing item already says what to do and has no raw text.
  expect(setup.items.find((i) => i.item === "release")).toMatchObject({ raw: null });
  // An error nobody mapped is general, and keeps its text for Details.
  const docs = (await repos(f.sources, "docs")).repo!.setup!.items[0]!;
  expect(docs).toMatchObject({ plain: "Towercab could not check this" });
  expect(docs.raw).toContain("add the ci repo to Towercab");
});

test("ui: setup check time is relative", async () => {
  const f = many();
  f.sources.db.setMeta(
    "settings:web",
    JSON.stringify({ state: "gaps", gaps: ["x differs"], tag: "v1", at: NOW - 3600 }),
  );
  const checked = (await repos(f.sources, "web")).repo!.settings.checked;
  expect(checked?.rel).toMatch(/ago$/);
  expect(checked?.exact).toBeTruthy();
});

const T = (at: number, from: string, event: string, to: string, why: string | null = null) => ({
  at: NOW - 3000 + at,
  from_stage: from as never,
  event,
  to_stage: to as never,
  why,
});
const M = { attempt: 1, created: NOW - 3100, stage: "done" as const };
const CLI = { kind: "cli" as const, hasLive: false, goLive: null };

test("ui: stage map leaves out stages that cannot apply and says so", () => {
  const map = stageMap(M, [T(0, "pick", "ok", "build"), T(60, "build", "ok", "done")], [], NOW, CLI);
  const ids = map.stages.map((s) => s.id);
  for (const gone of ["deploy", "e2e", "rollback", "revert"]) expect(ids).not.toContain(gone);
  expect(map.offPath).toEqual({
    names: ["deploying", "live tests", "rollback", "reverting"],
    reason: "a CLI has nothing to deploy",
  });
  // A stage the attempt visited is always listed, with its own outcome.
  const visited = stageMap(
    M,
    [T(0, "pick", "ok", "build"), T(60, "build", "ok", "deploy"), T(120, "deploy", "ok", "done")],
    [],
    NOW,
    CLI,
  );
  expect(visited.stages.find((s) => s.id === "deploy")?.outcome).toBe("passed");
  expect(visited.offPath?.names).not.toContain("deploying");
});

test("ui: unreached stages fold into one row", () => {
  // At the plan review the stages after it are all still ahead: the client folds the run into one row.
  const open = { attempt: 1, created: NOW - 3100, stage: "approval:plan" as const };
  const map = stageMap(
    open,
    [T(0, "pick", "ok", "design"), T(60, "design", "ok", "plan"), T(120, "plan", "wait", "approval:plan")],
    [],
    NOW,
    CLI,
  );
  const tail = map.stages.slice(map.stages.findIndex((s) => s.id === "plan_review") + 1);
  expect(tail.length).toBeGreaterThanOrEqual(7);
  expect(tail.every((s) => s.outcome === "not reached")).toBe(true);
});

test("ui: a merged change does not show merging as skipped", () => {
  const map = stageMap(
    M,
    [
      T(0, "pick", "ok", "build"),
      T(60, "build", "ok", "approval:merge"),
      T(120, "approval:merge", "code_merged", "done"),
    ],
    [],
    NOW,
    CLI,
  );
  expect(map.stages.find((s) => s.id === "merge")).toMatchObject({ outcome: "passed", note: null });
});

test("ui: a wait stage shows the owner's decision", () => {
  const map = stageMap(
    M,
    [
      T(0, "pick", "ok", "design"),
      T(60, "design", "wait", "approval:spec"),
      T(600, "approval:spec", "spec_merged", "plan"),
      T(700, "plan", "wait", "approval:plan"),
      T(900, "approval:plan", "feedback", "plan", "split it up"),
    ],
    [],
    NOW,
  );
  const by = (id: string) => map.stages.find((s) => s.id === id)!;
  expect(by("spec_review").decision).toMatchObject({ who: "You", what: "approved" });
  expect(by("spec_review").decision?.at.rel).toBeTruthy();
  expect(by("plan_review").decision).toMatchObject({ what: "asked for changes" });
  // Work the owner did not decide has none.
  expect(by("design").decision).toBeNull();
});

test("ui: a wait stage still open says what it waits for", () => {
  const open = { attempt: 1, created: NOW - 3100, stage: "approval:spec" as const };
  const map = stageMap(
    open,
    [T(0, "pick", "ok", "design"), T(60, "design", "wait", "approval:spec")],
    [],
    NOW,
  );
  const wait = map.stages.find((s) => s.id === "spec_review")!;
  // No decision yet; the client shows "Waiting for you: your spec review".
  expect(wait).toMatchObject({ decision: null, current: true, owner: true, outcome: "waiting on you" });
});
