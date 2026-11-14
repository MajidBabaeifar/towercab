// UI-278: the top bar shows the running version and, on the release channel, a waiting release.

import { afterEach, expect, test } from "vitest";
import { overview, type UiSources } from "../src/ui/state.ts";
import { buildFixture, type Fixture } from "../ui/fixture.ts";

const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});

async function topBar(version: UiSources["version"]) {
  const f = buildFixture({ now: new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000 });
  open.push(f);
  f.sources.version = version;
  return (await overview(f.sources)).top.version;
}

test("ui: top bar shows the running version", async () => {
  const v = await topBar(() => ({
    commit: "3f9c2ab71e0d",
    behind: 0,
    name: "v1.1.0",
    release: { running: "v1.1.0", available: null },
  }));
  expect(v.name).toBe("v1.1.0");
  expect(v.commit).toBe("3f9c2ab");
});

test("ui: top bar shows a waiting release", async () => {
  const v = await topBar(() => ({
    commit: "3f9c2ab71e0d",
    behind: 4,
    name: "v1.1.0",
    release: { running: "v1.1.0", available: "v1.2.0" },
  }));
  expect(v.release).toBe("v1.2.0 available");
  expect(v.behind).toBeNull();
});

test("ui: top bar shows no release note when up to date", async () => {
  const v = await topBar(() => ({
    commit: "3f9c2ab71e0d",
    behind: 4,
    name: "v1.1.0",
    release: { running: "v1.1.0", available: null },
  }));
  expect(v.release).toBeNull();
  // On the main channel the lag behind main is still said.
  const main = await topBar(() => ({
    commit: "3f9c2ab71e0d",
    behind: 2,
    name: "v1.1.0-2-g3f9c2ab",
    release: null,
  }));
  expect(main.behind).toBe("2 commits behind main");
});
