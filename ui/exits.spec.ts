// UI-164: the exit buttons of a wait and the stuck card, in light, dark and on a phone, saved for review
// with their key content checked.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

const PAGES = [
  {
    name: "exits-overview",
    path: "/",
    expect: [
      "Nothing to build: I did it myself",
      "Stuck: this came back with nothing new",
      "Towercab recommends",
      "Gives you the steps",
      "Drops the intent",
    ],
  },
] as const;

const MODES = [
  { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
  { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
  { mode: "mobile", scheme: "light", viewport: { width: 375, height: 812 } },
] as const;

test("ui: exits screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { exits: true });
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
        // The stuck card has no reply box of its own: one fewer "Send reply" than waits that take a reply.
        await expect(page.locator(".needs-card.stuck-card")).toHaveCount(1);
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
