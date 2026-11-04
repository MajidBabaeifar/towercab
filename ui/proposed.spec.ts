// UI-184 to UI-188: the proposed cards on the overview, a repo's page and the board, in light, dark and on a
// phone, with Accept and Close working from the page.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

const MODES = [
  { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
  { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
  { mode: "mobile", scheme: "light", viewport: { width: 375, height: 812 } },
] as const;

async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

test("ui: screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { proposed: true });
  const base = `http://localhost:${server.port()}`;
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
      const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

      await page.goto(`${base}/`);
      await settle(page);
      const section = page.locator("#proposed");
      await expect(section).toContainText("Proposed");
      await expect(section.locator(".proposed-card")).toHaveCount(5);
      await expect(section.locator(".proposed-card").first()).toContainText(
        "Export invoices as a spreadsheet",
      );
      await expect(section.locator("#proposed-202")).toContainText("Draft");
      await expect(section.locator("#proposed-203")).toContainText("would be parked");
      // A GitHub-only proposal says why it can't be accepted.
      await expect(section.locator("#proposed-204")).toContainText("Changes more than one intent");
      await expect(section.locator("#proposed-204").getByRole("button", { name: "Accept" })).toBeDisabled();
      expect(await noSideways(), `overview ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `proposed-overview-${m.mode}.png`), fullPage: true });

      await page.goto(`${base}/repos?repo=web`);
      await settle(page);
      await expect(page.locator(".repo-page")).toContainText("Proposed");
      await expect(page.locator(".proposed-card")).toHaveCount(2);
      expect(await noSideways(), `repo ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `proposed-repo-${m.mode}.png`), fullPage: true });

      await page.goto(`${base}/board`);
      await settle(page);
      await expect(page.locator(".hero")).toContainText("5 proposed");
      await expect(page.locator("body")).toContainText("2 proposed");
      expect(await noSideways(), `board ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `proposed-board-${m.mode}.png`), fullPage: true });
      await ctx.close();
    }

    // Accept and Close from the card; the card goes.
    const page = await browser.newPage();
    await page.goto(`${base}/#proposed-202`);
    await settle(page);
    await page.locator("#proposed-201").getByRole("button", { name: "Accept" }).click();
    await expect(page.locator("#proposed-201")).toHaveCount(0);
    await page.locator("#proposed-203").getByRole("button", { name: "Close" }).click();
    await page.locator("#proposed-203 input").fill("Not now.");
    await page.locator("#proposed-203").getByRole("button", { name: "Close the PR" }).click();
    await expect(page.locator("#proposed-203")).toHaveCount(0);
    expect(fixture.calls.filter((c) => c.pr).map((c) => [c.action, c.pr, c.text ?? null])).toEqual([
      ["accept", 201, null],
      ["close", 203, "Not now."],
    ]);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
