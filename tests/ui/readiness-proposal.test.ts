// UI-156: the repo page links the pull request that proposes the repo's setup intent.

import { afterEach, expect, test } from "vitest";
import { repos } from "../../src/ui/repos.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function fixture(o: { readiness?: boolean } = {}): Fixture {
  const f = buildFixture({ now: NOW, ...o });
  cleanup.push(() => f.cleanup());
  return f;
}

test("ui: a repo page links the open setup proposal", async () => {
  const f = fixture({ readiness: true });
  const page = await repos(f.sources, "web");
  expect(page.repo?.setup?.proposal).toEqual({
    url: "https://github.com/acme/intents/pull/210",
    title: "web is set up as a library and ready for work",
  });
  expect(page.repo?.setup?.blocks).toBe(true);
  expect((await repos(f.sources, "api")).repo?.setup?.proposal).toBeNull();
  expect((await repos(fixture().sources, null)).chips.every((c) => c.readiness === undefined)).toBe(true);
  const labels = Object.fromEntries(
    (await repos(f.sources, null)).chips.map((c) => [c.repo, c.readiness?.label]),
  );
  expect(labels).toMatchObject({
    web: "Not ready · new work paused",
    api: "Not ready",
    docs: "Could not check",
  });
});
