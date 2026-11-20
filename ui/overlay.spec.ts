// UI-276 in a real browser: a setting the overlay holds has no edit control and says where to change it.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { viewKey } from "../src/repo/poll.ts";
import { startUi } from "../src/ui/server.ts";
import { buildFixture } from "./fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("ui: an overlay setting has no edit control", async ({ page }) => {
  const fixture = buildFixture();
  fixture.db.setMeta(
    viewKey("web"),
    JSON.stringify({
      path: "/cfg/repos/web/TOWERCAB.md",
      rows: [
        { key: "workers", value: "1", source: "overlay" },
        { key: "ahead", value: "3", source: "default" },
        { key: "checks", value: "make test", source: "repo" },
      ],
      refusals: ["overlay tests refused: looser than the repo's value"],
      error: null,
    }),
  );
  const server = startUi({
    port: 0,
    sources: fixture.sources,
    actions: fixture.actions,
    distDir: resolve(here, "dist"),
    log: () => {},
    pollMs: 500,
  });
  await server.ready;
  try {
    await page.goto(`http://localhost:${server.port()}/repos?repo=web`);
    await page.waitForSelector(".repo-limits");
    await expect(page.getByLabel("Missions building at once")).toHaveCount(0);
    await expect(page.getByText("Set in /cfg/repos/web/TOWERCAB.md.")).toBeVisible();
    // The key the repo or the default holds can still be edited.
    await expect(page.getByLabel("Intents ahead of build")).toBeVisible();
    await expect(page.getByText("overlay tests refused: looser than the repo's value")).toBeVisible();
    await expect(page.locator(".source-tag.overlay").first()).toBeVisible();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
