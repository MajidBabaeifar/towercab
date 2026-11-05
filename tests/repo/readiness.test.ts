// Repo readiness (REPO-20..24, REPO-26, REPO-27): kind and waivers in TOWERCAB.md, the suggestion, the
// required setup, how each item is read from files, and the stage map's skip reasons. All pure.

import { expect, test } from "vitest";
import { parseTowercab } from "../../src/repo/files.ts";
import {
  type Check,
  checkItems,
  type Evidence,
  type Item,
  KINDS,
  type Kind,
  missing,
  repoReadiness,
  requiredSetup,
  stageSkip,
  suggestKind,
} from "../../src/repo/readiness.ts";

const fm = (body: string) => `---\n${body}\n---\n`;

test("repo: TOWERCAB.md kind", () => {
  expect(parseTowercab("").kind).toBeUndefined();
  for (const k of KINDS) expect(parseTowercab(fm(`kind: ${k}`)).kind).toBe(k);
  expect(parseTowercab(fm("kind: infra\ngo_live: merge, then ansible runs")).goLive).toBe(
    "merge, then ansible runs",
  );
});

test("repo: an unknown kind is invalid", () => {
  expect(() => parseTowercab(fm("kind: robot"))).toThrow(
    "kind: robot isn't one of service, site, cli, library, spec-only, infra",
  );
});

test("repo: TOWERCAB.md readiness and waive", () => {
  expect(parseTowercab("").readiness).toBeUndefined();
  const t = parseTowercab(
    fm('kind: library\nreadiness: block\nwaive:\n  - publish: not released yet\n  - "ci: runs elsewhere"'),
  );
  expect(t.readiness).toBe("block");
  expect(t.waive).toEqual([
    { item: "publish", reason: "not released yet" },
    { item: "ci", reason: "runs elsewhere" },
  ]);
});

test("repo: a bad readiness or waive line is invalid", () => {
  expect(() => parseTowercab(fm("readiness: strict"))).toThrow("readiness: strict isn't warn or block");
  expect(() => parseTowercab(fm("waive:\n  - flying: no"))).toThrow("waive: flying: not an item");
  expect(() => parseTowercab(fm("waive:\n  - ci"))).toThrow("waive: ci: needs a reason");
  expect(() => parseTowercab(fm("waive: ci"))).toThrow("waive must be a list");
});

test("repo: suggest a kind from files", () => {
  expect(suggestKind(["main.tf", "README.md"])).toBe("infra");
  expect(suggestKind(["Dockerfile", "src/app.ts"])).toBe("service");
  expect(suggestKind(["astro.config.mjs", "src/pages/index.astro"])).toBe("site");
  expect(suggestKind(["index.html"])).toBe("site");
  expect(suggestKind(["package.json", "src/cli.ts"], { packageJson: { bin: { x: "cli.js" } } })).toBe("cli");
  expect(suggestKind(["Cargo.toml", "src/main.rs"])).toBe("cli");
  expect(suggestKind(["package.json"], { packageJson: { main: "index.js" } })).toBe("library");
  expect(suggestKind(["Cargo.toml", "src/lib.rs"])).toBe("library");
  expect(suggestKind(["README.md", "specs/a.md", "specs/b.txt"])).toBe("spec-only");
  // The first rule wins: a Dockerfile in a repo with terraform is infra.
  expect(suggestKind(["Dockerfile", "infra/main.tf"])).toBe("infra");
});

test("repo: no suggestion when nothing matches", () => {
  expect(suggestKind([])).toBeNull();
  expect(suggestKind(["src/a.ts", "package.json"], { packageJson: {} })).toBeNull();
});

test("repo: required setup per kind", () => {
  const every: Item[] = ["ci", "settings", "release", "verifying"];
  expect(requiredSetup("spec-only")).toEqual(every);
  expect(requiredSetup(null)).toEqual(every);
  expect(requiredSetup("service")).toEqual([...every, "image", "apps", "deploy", "live"]);
  expect(requiredSetup("site")).toEqual([...every, "live"]);
  expect(requiredSetup("cli")).toEqual([...every, "publish"]);
  expect(requiredSetup("library")).toEqual([...every, "publish"]);
  expect(requiredSetup("infra")).toEqual([...every, "go_live"]);
});

const liveOf = (smoke: boolean) =>
  parseTowercab(
    fm(
      `live:\n  url: https://app.example.com\n  suites:\n    - name: drill\n      command: npm run e2e\n      tests: [e2e/**]${smoke ? "\n      smoke: true" : ""}`,
    ),
  ).live;
const LIVE = liveOf(true);

function evidence(o: Partial<Evidence> = {}): Evidence {
  return {
    paths: [],
    workflows: "",
    requiredChecks: true,
    settings: { state: "present" },
    appsEntry: true,
    verifying: true,
    live: null,
    goLive: null,
    ...o,
  };
}
const state = (m: Map<Item, Check>, item: Item) => m.get(item)?.state;

test("repo: each setup item is checked from files", () => {
  const good = evidence({
    paths: [".github/workflows/ci.yml", "release-please-config.json", ".release-please-manifest.json"],
    workflows:
      "jobs:\n  test:\n    steps: []\n  deploy:\n    steps: []\n  publish:\n    steps: []\n  release:\n    uses: googleapis/release-please-action@v4\n  image:\n    steps:\n      - run: docker build .\n      - run: cosign sign img\n",
    live: LIVE,
    goLive: null,
  });
  const all = (["service", "cli"] as const).map((k) => checkItems(k, good));
  for (const m of all) for (const [, c] of m) expect(c.state).toBe("present");

  const bare = checkItems("service", evidence());
  for (const item of ["ci", "release", "image", "deploy", "live"] as const) {
    expect(state(bare, item), item).toBe("missing");
  }
  expect(state(checkItems("cli", evidence({ workflows: "run: npm publish" })), "publish")).toBe("present");
  expect(state(checkItems("cli", evidence()), "publish")).toBe("missing");
  // Required checks that GitHub can't report are unknown, not missing.
  const unknown = checkItems(
    "library",
    evidence({ paths: [".github/workflows/ci.yml"], requiredChecks: null }),
  );
  expect(state(unknown, "ci")).toBe("unknown");
  expect(state(checkItems("library", evidence({ verifying: false })), "verifying")).toBe("missing");
  // The shared image workflow of ci counts as a signed image.
  const shared = evidence({ workflows: "uses: owner/ci/.github/workflows/image.yml@main" });
  expect(state(checkItems("service", shared), "image")).toBe("present");
  expect(state(checkItems("infra", evidence({ goLive: "merge to main" })), "go_live")).toBe("present");
  expect(state(checkItems("infra", evidence()), "go_live")).toBe("missing");
});

test("repo: apps entry is read from infra", () => {
  expect(state(checkItems("service", evidence({ appsEntry: true })), "apps")).toBe("present");
  expect(state(checkItems("service", evidence({ appsEntry: false })), "apps")).toBe("missing");
  expect(state(checkItems("service", evidence({ appsEntry: null })), "apps")).toBe("unknown");
});

test("repo: live needs a smoke suite", () => {
  const noSmoke = liveOf(false);
  expect(state(checkItems("site", evidence({ live: LIVE })), "live")).toBe("present");
  expect(state(checkItems("site", evidence({ live: noSmoke })), "live")).toBe("missing");
  expect(state(checkItems("site", evidence()), "live")).toBe("missing");
});

test("repo: readiness lists each missing item in words", () => {
  const checks = checkItems("service", evidence());
  const r = repoReadiness("service", true, checks, []);
  expect(r.ready).toBe(false);
  expect(missing(r).map((i) => i.item)).toEqual(["ci", "release", "image", "deploy", "live"]);
  expect(r.items.find((i) => i.item === "image")?.words).toBe(
    "No signed image: add a workflow that builds and signs one",
  );
  expect(
    repoReadiness(
      "spec-only",
      true,
      checkItems("spec-only", evidence({ paths: [".github/workflows/a.yml"], workflows: "release-please" })),
      [],
    ).ready,
  ).toBe(false);
  const ok = new Map<Item, Check>(requiredSetup("spec-only").map((i) => [i, { state: "present" as const }]));
  expect(repoReadiness("spec-only", true, ok, []).ready).toBe(true);
});

test("repo: an unconfirmed kind uses the suggestion and only warns", () => {
  const checks = checkItems("library", evidence());
  const r = repoReadiness("library", false, checks, [], "block");
  expect(r.kind).toBe("library");
  expect(r.suggested).toBe("library");
  expect(r.ready).toBe(false);
  expect(r.items[0]).toEqual({
    item: "kind",
    state: "missing",
    words: "Say what kind of repo this is: add kind to TOWERCAB.md (suggested: kind: library)",
  });
  // Even with readiness: block in the file, nothing blocks until the kind is confirmed.
  expect(r.blocks).toBe(false);
  // No suggestion: only the every-repo items and the kind line.
  const none = repoReadiness(null, false, new Map(), []);
  expect(none.items.map((i) => i.item)).toEqual(["kind", "ci", "settings", "release", "verifying"]);
});

test("repo: a waived item counts as present", () => {
  const checks = checkItems("library", evidence());
  const open = repoReadiness("library", true, checks, [], "block");
  expect(missing(open).map((i) => i.item)).toContain("publish");
  const waived = repoReadiness(
    "library",
    true,
    checks,
    missing(open).map((i) => ({ item: i.item, reason: `later: ${i.item}` })),
    "block",
  );
  expect(waived.ready).toBe(true);
  expect(waived.blocks).toBe(false);
  expect(waived.items.find((i) => i.item === "publish")).toEqual({
    item: "publish",
    state: "waived",
    words: "later: publish",
  });
});

test("repo: only a confirmed block repo blocks", () => {
  const checks = checkItems("library", evidence());
  const blocks = (confirmed: boolean, mode: "warn" | "block") =>
    repoReadiness("library", confirmed, checks, [], mode).blocks;
  expect(blocks(true, "block")).toBe(true);
  expect(blocks(true, "warn")).toBe(false);
  expect(blocks(false, "block")).toBe(false);
  // An unknown item is a warning: it never makes a repo not ready.
  const unknownOnly = new Map<Item, Check>(
    requiredSetup("library").map((i) => [
      i,
      { state: i === "settings" ? ("unknown" as const) : ("present" as const) },
    ]),
  );
  const r = repoReadiness("library", true, unknownOnly, [], "block");
  expect(r.ready).toBe(true);
  expect(r.blocks).toBe(false);
});

test("repo: ship stages are skipped with a reason for kinds that do not deploy", () => {
  const why = (kind: Kind | null, hasLive = false, goLive: string | null = null) =>
    stageSkip(kind, hasLive, goLive, "deploy");
  expect(why("library")).toBe("a library has nothing to deploy");
  expect(why("cli")).toBe("a CLI has nothing to deploy");
  expect(why("spec-only")).toBe("a spec-only repo has nothing to deploy");
  expect(why("infra", false, "ansible runs on merge")).toBe(
    "this repo's changes go live outside Towercab: ansible runs on merge",
  );
  expect(why(null)).toBe("kind not set");
  expect(why("service")).toBeNull();
  expect(why("site")).toBeNull();
  // A valid live block makes the stages apply whatever the kind.
  expect(why("library", true)).toBeNull();
  // Stages before the merge always apply.
  expect(stageSkip("library", false, null, "build")).toBeNull();
  for (const s of ["e2e", "rollback", "revert"]) expect(stageSkip("cli", false, null, s)).not.toBeNull();
});

test("repo: a failed readiness read keeps the last result", () => {
  // A read that failed is `unknown`, never `missing` (REPO-27).
  const checks = checkItems(
    "service",
    evidence({ appsEntry: null, requiredChecks: null, paths: [".github/workflows/a.yml"] }),
  );
  expect(state(checks, "apps")).toBe("unknown");
  expect(state(checks, "ci")).toBe("unknown");
});

test("repo: no stored result never blocks", () => {
  // Nothing checked yet: every required item is unknown, so the repo is ready and cannot block.
  const r = repoReadiness("library", true, new Map(), [], "block");
  expect(r.items.every((i) => i.state === "unknown" && i.words === "Not checked yet")).toBe(true);
  expect(r.ready).toBe(true);
  expect(r.blocks).toBe(false);
});
