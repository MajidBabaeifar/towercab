// UI-155..159: the not-ready badge on the Repos tab and the Board, what a repo is missing, and the stage
// map that always lists the ship stages with the reason a kind skips them.

import { afterEach, expect, test } from "vitest";
import {
  type Check,
  type Item,
  type Kind,
  repoReadiness,
  requiredSetup,
  type Stored,
} from "../../src/repo/readiness.ts";
import { board } from "../../src/ui/board.ts";
import { repos } from "../../src/ui/repos.ts";
import { intentPage, stageMap } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function fixture(): Fixture {
  const f = buildFixture({ now: NOW });
  cleanup.push(() => f.cleanup());
  return f;
}

/** Store a result for `repo`: `kind`, with `missing` items missing and `waived` waived. */
function store(
  f: Fixture,
  repo: string,
  o: {
    kind?: Kind | null;
    confirmed?: boolean;
    mode?: "warn" | "block";
    missing?: Item[];
    unknown?: Item[];
    waived?: Record<string, string>;
    hasLive?: boolean;
    goLive?: string | null;
  } = {},
): void {
  const kind = o.kind === undefined ? "library" : o.kind;
  const checks = new Map<Item, Check>(
    requiredSetup(kind).map((i) => [
      i,
      o.missing?.includes(i)
        ? { state: "missing" as const }
        : o.unknown?.includes(i)
          ? { state: "unknown" as const, words: "GitHub could not say" }
          : { state: "present" as const },
    ]),
  );
  const waive = Object.entries(o.waived ?? {}).map(([item, reason]) => ({ item: item as Item, reason }));
  const s: Stored = {
    base: "abc",
    at: NOW,
    readiness: repoReadiness(kind, o.confirmed ?? true, checks, waive, o.mode ?? "warn"),
    goLive: o.goLive ?? null,
    hasLive: o.hasLive ?? false,
  };
  f.sources.db.setMeta(`readiness:${repo}`, JSON.stringify(s));
}

test("ui: repos chips and cards show the not-ready badge", async () => {
  const f = fixture();
  const plain = await repos(f.sources, null);
  expect(plain.chips.every((c) => c.readiness === undefined)).toBe(true);
  store(f, "web", { missing: ["publish"], mode: "block" });
  store(f, "api", { missing: ["publish"] });
  store(f, "docs", { unknown: ["settings"] });
  store(f, "mobile", {});
  const page = await repos(f.sources, null);
  const badge = (repo: string) => page.chips.find((c) => c.repo === repo)!.readiness;
  expect(badge("web")).toMatchObject({ label: "Not ready · new work paused", blocks: true, missing: 1 });
  expect(badge("web")?.name).toBe("Not ready · new work paused: 1 missing");
  expect(badge("api")).toMatchObject({ label: "Not ready", blocks: false, missing: 1 });
  expect(badge("docs")).toMatchObject({ label: "Could not check", missing: 0, unknown: 1 });
  expect(badge("mobile")).toBeUndefined();
  // The same badge is on the card of the All view.
  expect(page.all.find((s) => s.repo === "web")?.readiness).toEqual(badge("web"));
  expect(page.all.find((s) => s.repo === "mobile")?.readiness).toBeUndefined();
  // A new check changes the page's version, so an open page updates.
  const before = page.version;
  store(f, "web", { missing: [], mode: "block" });
  expect((await repos(f.sources, null)).version).not.toBe(before);
});

test("ui: a not-ready repo page lists what is missing", async () => {
  const f = fixture();
  expect((await repos(f.sources, "web")).repo?.setup).toBeUndefined();
  store(f, "web", {
    kind: "library",
    confirmed: false,
    missing: ["publish"],
    unknown: ["settings"],
    mode: "block",
  });
  const warn = (await repos(f.sources, "web")).repo!.setup!;
  expect(warn.blocks).toBe(false);
  expect(warn.items.map((i) => [i.item, i.state])).toEqual([
    ["kind", "missing"],
    ["settings", "unknown"],
    ["publish", "missing"],
  ]);
  expect(warn.items[0]?.words).toContain("(suggested: kind: library)");
  expect(warn.hint).toEqual(["kind: library"]);
  expect(warn.sentence).toContain("warning only");
  // A confirmed kind that blocks: new intents wait, and the setup intent is named when one exists.
  store(f, "web", { confirmed: true, missing: ["publish"], mode: "block" });
  const blocking = (await repos(f.sources, "web")).repo!.setup!;
  expect(blocking.blocks).toBe(true);
  expect(blocking.sentence).toContain("New intents wait");
  expect(blocking.intent).toBeNull();
  // Confirmed, missing, still warning: the page says how to start holding work back.
  store(f, "web", { confirmed: true, missing: ["publish"], mode: "warn" });
  expect((await repos(f.sources, "web")).repo!.setup!.hint).toEqual(["readiness: block"]);
  // Nothing missing: no section.
  store(f, "web", {});
  expect((await repos(f.sources, "web")).repo?.setup).toBeUndefined();
});

test("ui: a repo page shows waived items with their reason", async () => {
  const f = fixture();
  store(f, "web", { missing: [], waived: { publish: "not released yet" } });
  const setup = (await repos(f.sources, "web")).repo!.setup!;
  expect(setup.items).toEqual([
    {
      item: "publish",
      state: "waived",
      words: "Waived: not released yet",
      plain: "Waived: not released yet",
      raw: null,
    },
  ]);
  // A waived item is not a gap: no badge.
  expect((await repos(f.sources, null)).chips.find((c) => c.repo === "web")?.readiness).toBeUndefined();
});

test("ui: board lanes show the not-ready badge", async () => {
  const f = fixture();
  expect((await board(f.sources)).repos.every((r) => r.readiness === undefined)).toBe(true);
  store(f, "web", { missing: ["release"], mode: "block" });
  const b = await board(f.sources);
  expect(b.repos.find((r) => r.repo === "web")?.readiness).toMatchObject({
    label: "Not ready · new work paused",
    detail: "Release-please is not set up: add its config, manifest and workflow",
  });
  expect(b.repos.find((r) => r.repo === "api")?.readiness).toBeUndefined();
});

const moves = (stages: [string, string][]) =>
  stages.map(([from, to], n) => ({
    at: NOW - 600 + n * 60,
    from_stage: from as never,
    event: "ok",
    to_stage: to as never,
    why: null,
  }));
const MERGED = moves([
  ["build", "merge"],
  ["merge", "done"],
]);
const SHIP = ["deploy", "e2e", "rollback", "revert"];

test("ui: stage map lists every stage for every repo", () => {
  const m = { attempt: 1, created: NOW - 700, stage: "done" as const };
  const ids = (repo?: { kind: Kind | null; hasLive: boolean; goLive: string | null }) =>
    stageMap(m, MERGED, [], NOW, repo).stages.map((s) => s.id);
  // UI-272: a repo with something to deploy lists the ship stages; the same list for every such kind.
  const full = ids({ kind: "service", hasLive: true, goLive: null });
  for (const stage of SHIP) expect(full).toContain(stage);
  expect(ids({ kind: "site", hasLive: false, goLive: null })).toEqual(full);
  // Stages that cannot apply are left out; every other stage is still listed.
  const library = ids({ kind: "library", hasLive: false, goLive: null });
  for (const stage of SHIP) expect(library).not.toContain(stage);
  expect(library).toEqual(full.filter((id) => !SHIP.includes(id)));
  // Applicable ship stages that were never reached are "not reached", not skipped.
  const service = stageMap(m, MERGED, [], NOW, { kind: "service", hasLive: true, goLive: null });
  expect(service.stages.find((s) => s.id === "deploy")).toMatchObject({ outcome: "not reached", note: null });
  expect(service.offPath).toBeNull();
  // Unknown repo setup: the map it always had.
  expect(ids()).not.toContain("deploy");
});

test("ui: ship stages are skipped with the kind's reason", async () => {
  const m = { attempt: 1, created: NOW - 700, stage: "done" as const };
  // UI-159, UI-272: the kind's reason is the tooltip of the one line that sums the stages up.
  const off = (kind: Kind | null, goLive: string | null = null) =>
    stageMap(m, MERGED, [], NOW, { kind, hasLive: false, goLive }).offPath;
  expect(off("library")).toEqual({
    names: ["deploying", "live tests", "rollback", "reverting"],
    reason: "a library has nothing to deploy",
  });
  expect(off("cli")?.reason).toBe("a CLI has nothing to deploy");
  expect(off("spec-only")?.reason).toBe("a spec-only repo has nothing to deploy");
  expect(off("infra", "ansible on merge")?.reason).toBe(
    "this repo's changes go live outside Towercab: ansible on merge",
  );
  expect(off(null)?.reason).toBe("kind not set");
  // A stage the attempt did visit keeps its own outcome.
  const visited = stageMap(
    m,
    moves([
      ["build", "merge"],
      ["merge", "deploy"],
      ["deploy", "done"],
    ]),
    [],
    NOW,
    { kind: "library", hasLive: false, goLive: null },
  );
  expect(visited.stages.find((s) => s.id === "deploy")?.outcome).toBe("passed");
  // The intent page reads the kind from the stored result.
  const f = fixture();
  const plain = await intentPage(f.sources, IDS.code);
  expect(plain!.attempts[0]!.map.stages.map((s) => s.id)).not.toContain("rollback");
  store(f, "docs", { kind: "library" });
  const page = await intentPage(f.sources, IDS.code);
  const map = page!.attempts[0]!.map;
  expect(map.stages.map((s) => s.id)).not.toContain("rollback");
  expect(map.offPath).toMatchObject({ reason: "a library has nothing to deploy" });
});
