// UI-276: the repo page says where each setting comes from, shows what the overlay was refused and the notice
// that the repo's own checks replaced the overlay's.

import { afterEach, expect, test } from "vitest";
import { noticeKey, type SettingsViewMeta, viewKey } from "../../src/repo/poll.ts";
import { board } from "../../src/ui/board.ts";
import { repos } from "../../src/ui/repos.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";

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
const limitsOf = async (f: Fixture) => (await repos(f.sources, "web")).repo!.limits;

const view = (over: Partial<SettingsViewMeta> = {}): string =>
  JSON.stringify({
    path: "/cfg/repos/web/TOWERCAB.md",
    rows: [
      { key: "max_autonomy", value: "2", source: "overlay" },
      { key: "tests", value: "t/**", source: "repo" },
      { key: "workers", value: "1", source: "default" },
      { key: "checks", value: "make test", source: "repo" },
    ],
    refusals: [],
    error: null,
    ...over,
  } satisfies SettingsViewMeta);

test("ui: settings show repo, overlay or default", async () => {
  const f = fixture();
  // Before the loop has read the repo, nothing is claimed.
  expect((await limitsOf(f)).sources).toBeUndefined();
  f.db.setMeta(viewKey("web"), view());
  const s = (await limitsOf(f)).sources!;
  expect(s.rows.map((r) => `${r.key}:${r.source}`)).toEqual([
    "max_autonomy:overlay",
    "tests:repo",
    "workers:default",
    "checks:repo",
  ]);
  expect(s.overlayPath).toBe("/cfg/repos/web/TOWERCAB.md");
  expect(s.notice).toBeNull();
  // A repo without an overlay has repo and default labels only, and no overlay path.
  f.db.setMeta(
    viewKey("web"),
    view({ path: null, rows: [{ key: "workers", value: "1", source: "default" }] }),
  );
  const plain = (await limitsOf(f)).sources!;
  expect(plain.overlayPath).toBeNull();
  expect(plain.rows.every((r) => r.source !== "overlay")).toBe(true);
});

test("ui: a refused overlay key shows its line", async () => {
  const f = fixture();
  const line = "overlay tests refused: looser than the repo's value";
  f.db.setMeta(viewKey("web"), view({ refusals: [line] }));
  expect((await limitsOf(f)).sources!.refusals).toEqual([line]);
  // An invalid overlay shows its reason.
  f.db.setMeta(viewKey("web"), view({ rows: [], error: "overlay TOWERCAB.md: front matter: workers twice" }));
  expect((await limitsOf(f)).sources!.error).toBe("overlay TOWERCAB.md: front matter: workers twice");
});

test("ui: replaced overlay checks show a notice", async () => {
  const f = fixture();
  const text =
    "web: the repo now has its own checks (CLAUDE.md on main), so the overlay's checks are no longer used.";
  f.db.setMeta(viewKey("web"), view());
  f.db.setMeta(noticeKey("web"), JSON.stringify({ hash: "h", text }));
  expect((await limitsOf(f)).sources!.notice).toBe(text);
  // The card in the All view and the Board lane carry it too.
  const all = await repos(f.sources, null);
  expect(JSON.stringify(all)).toContain(text);
  const b = await board(f.sources);
  expect(JSON.stringify(b)).toContain(text);
  f.db.delMeta(noticeKey("web"));
  expect((await limitsOf(f)).sources!.notice).toBeNull();
});
