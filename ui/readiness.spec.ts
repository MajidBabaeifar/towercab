// UI-155..157: the "Not ready" badge and the "Set up this repo" section on the Repos tab and the Board, in
// light, dark and on a phone, saved for review with their key content checked.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

const PAGES = [
  { name: "readiness-repos", path: "/repos", expect: ["Not ready · new work paused", "Could not check"] },
  {
    name: "readiness-repo",
    path: "/repos?repo=web",
    expect: [
      "Set up this repo",
      "Release-please is not set up",
      "Release publishing is not set up",
      "New intents wait in this repo",
      "Proposed setup, waiting for you to merge it",
      "web is set up as a library and ready for work",
    ],
  },
  { name: "readiness-board", path: "/board", expect: ["Not ready · new work paused"] },
] as const;

const MODES = [
  { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
  { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
  { mode: "mobile", scheme: "light", viewport: { width: 375, height: 812 } },
] as const;

test("ui: readiness screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { readiness: true });
  try {
    for (const m of MODES) {
      const ctx = await browser.newContext({
        colorScheme: m.scheme,
        viewport: m.viewport,
        deviceScaleFactor: m.mode === "mobile" ? 2 : 1,
        isMobile: m.mode === "mobile",
        hasTouch: m.mode === "mobile",
      });
      const page = await ctx.newPage();
      for (const p of PAGES) {
        await page.goto(`http://localhost:${server.port()}${p.path}`);
        await page.waitForSelector(".page");
        await page.waitForLoadState("networkidle");
        for (const text of p.expect) await expect(page.locator("body")).toContainText(text);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${p.name} ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: join(SHOTS, `${p.name}-${m.mode}.png`), fullPage: true });
      }
      await ctx.close();
    }
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
