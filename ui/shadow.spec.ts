// UI-236 to UI-238 in Chromium: the shadow panel, its tag and Reset; hidden when the shadow is off.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { IDS, seedShadow, serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

let url = "";
let stop: () => Promise<void> = async () => {};

test.beforeAll(async () => {
  // A fixture of its own with the shadow on; the shared one (the base URL) has it off.
  const { fixture, server } = await serveFixture(0);
  seedShadow(fixture, Date.now() / 1000);
  url = server.url() ?? "";
  stop = async () => {
    await server.stop();
    fixture.cleanup();
  };
});
test.afterAll(async () => stop());

async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

test("ui: shadow panel is hidden when off", async ({ page }) => {
  await page.goto("/overview");
  await settle(page);
  await expect(page.locator("#shadow")).toHaveCount(0);
});

test("ui: shadow reset asks first and resets", async ({ page }) => {
  await page.goto(`${url}overview`);
  await settle(page);
  const panel = page.locator("#shadow");
  await expect(panel).toContainText("[shadow]");
  await expect(panel).toContainText("Drafted");
  await expect(panel).toContainText("$1.25 of $5.00 today");
  await expect(panel).toContainText("Waiting for your yes in Telegram: merge");
  await expect(panel.locator("a", { hasText: "intent" }).first()).toBeVisible();
  // Reset asks before it does anything.
  await panel.getByRole("button", { name: "Reset" }).click();
  await expect(panel).toContainText("Forget the whole conversation?");
  await panel.getByRole("button", { name: "Keep it" }).click();
  await expect(panel).not.toContainText("Forget the whole conversation?");
  await panel.getByRole("button", { name: "Reset" }).click();
  await panel.getByRole("button", { name: "Yes, reset" }).click();
  await expect(panel).toContainText("Cleared the shadow's conversation");
  // The log of what it did stays.
  await expect(panel.locator(".shadow-action").first()).toBeVisible();
});

test("ui: the shadow tag shows on its draft", async ({ page }) => {
  await page.goto(`${url}i/${IDS.upnext}`);
  await settle(page);
  await expect(page.locator("h1")).toContainText("[shadow]");
  await page.locator("summary", { hasText: "All moves" }).click();
  await expect(page.locator(".timeline")).toContainText("[shadow] Drafted");
});

test("ui: shadow panel on a phone", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const [mode, scheme, width] of [
    ["light", "light", 1280],
    ["dark", "dark", 1280],
    ["mobile", "light", 360],
  ] as const) {
    const ctx = await browser.newContext({
      colorScheme: scheme,
      viewport: { width, height: width === 360 ? 800 : 900 },
      isMobile: mode === "mobile",
      hasTouch: mode === "mobile",
    });
    const page = await ctx.newPage();
    await page.goto(`${url}overview`);
    await settle(page);
    await expect(page.locator("#shadow")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const h = await page
      .locator("#shadow .btn")
      .first()
      .evaluate((b) => b.getBoundingClientRect().height);
    expect(h).toBeGreaterThanOrEqual(44);
    await page.locator("#shadow").screenshot({ path: join(SHOTS, `shadow-${mode}.png`) });
    await ctx.close();
  }
});
