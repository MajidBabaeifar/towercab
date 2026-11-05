// UI-146 and UI-149 in the browser: the Board's sort control by keyboard, remembered, and at 360 px.

import { expect, type Page, test } from "@playwright/test";

async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

/** The repo names of the visible lane headers, top to bottom. */
const lanes = (page: Page) => page.locator(".board-toggle:visible span").allTextContents();

test("ui: board sort works by keyboard and at 360px", async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto("/board");
  await settle(page);

  const select = page.getByLabel("Sort by");
  await expect(select).toHaveValue("needs");
  // Needs you first, ties in config order; then the repos nothing waits on, in config order.
  expect(await lanes(page)).toEqual(["web", "api", "docs", "crm", "mobile", "infra", "blog"]);

  // The control fits and the page doesn't scroll sideways.
  const box = (await select.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

  // Tab reaches it, the arrow keys change it, and the change is announced politely.
  await select.focus();
  await expect(select).toBeFocused();
  await select.selectOption("name");
  expect(await lanes(page)).toEqual(["api", "blog", "crm", "docs", "infra", "mobile", "web"]);
  await expect(page.locator('[role="status"]', { hasText: "Sorted by Name" })).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(select).toHaveValue("config");
  expect(await lanes(page)).toEqual(["web", "api", "docs", "mobile", "infra", "blog", "crm"]);

  // Remembered per browser, and a reload keeps it.
  await page.reload();
  await settle(page);
  await expect(select).toHaveValue("config");

  // Without storage the sort still applies until the page reloads.
  const blocked = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await blocked.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("storage is disabled");
      },
    });
  });
  const p2 = await blocked.newPage();
  await p2.goto("/board");
  await settle(p2);
  const s2 = p2.getByLabel("Sort by");
  await expect(s2).toHaveValue("needs");
  await s2.selectOption("todo");
  expect((await lanes(p2))[0]).toBe("web");
  await s2.selectOption("latest");
  expect(await lanes(p2)).toEqual(["web", "mobile", "docs", "api", "infra", "blog", "crm"]);
  await ctx.close();
  await blocked.close();
});
