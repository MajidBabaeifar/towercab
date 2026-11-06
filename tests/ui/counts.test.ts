// UI-244: one count of what needs the owner, the same on every screen.

import { afterEach, expect, test } from "vitest";
import { board } from "../../src/ui/board.ts";
import { focus } from "../../src/ui/focus.ts";
import { repos } from "../../src/ui/repos.ts";
import { overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});
function crowded(): Fixture {
  const f = buildFixture({ now: NOW, crowded: true });
  open.push(f);
  return f;
}

test("ui: every screen counts the same things that need you", async () => {
  const f = crowded();
  const o = await overview(f.sources);
  const fo = await focus(f.sources);
  const b = await board(f.sources);
  const r = await repos(f.sources, null);
  const total = o.top.needs;
  expect(total).toBeGreaterThan(10);
  // Focus shows one and says how many more.
  expect(fo.item).not.toBeNull();
  expect(1 + fo.more).toBe(total);
  // The Board: its "Needs you" chips and its proposed count.
  expect(b.repos.reduce((n, row) => n + row.waiting, 0) + (b.proposed ?? 0)).toBe(total);
  // Repos: each repo's part (the repos without a lane are on the Board).
  const lane = r.chips.reduce((n, c) => n + c.needs, 0);
  const off = b.repos
    .filter((row) => !r.chips.some((c) => c.repo === row.repo))
    .reduce((n, row) => n + row.waiting + row.proposed, 0);
  expect(lane + off).toBe(total);
  // The airspace and the tab's count are the same number.
  expect(o.airspace.counts.needs).toBe(total);
  expect(o.top.countsText.startsWith(`${total} need`)).toBe(true);
});

test("ui: the headline parts add up to the focus and board counts", async () => {
  const f = crowded();
  const o = await overview(f.sources);
  const fo = await focus(f.sources);
  const b = await board(f.sources);
  const waiting = o.needs.filter((c) => !c.done).length;
  expect(o.top.proposed).toBe(o.proposed!.cards.length);
  expect(waiting + o.top.proposed).toBe(o.top.needs);
  expect(waiting + o.top.proposed).toBe(1 + fo.more);
  expect(b.repos.reduce((n, row) => n + row.waiting, 0) + (b.proposed ?? 0)).toBe(o.top.needs);
  expect(o.needs.some((c) => c.kindLabel === "Your steps")).toBe(true);
});
