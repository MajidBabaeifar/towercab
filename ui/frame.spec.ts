// FRAME-1..6, CHAT-1..10: the sidebar frame and an intent's chat, on a desktop and on a phone.

import { expect, test } from "@playwright/test";
import { inboxFixture, PHONE } from "./inbox-helpers.ts";

test("frame: the sidebar lists open intents by repo with stage and state", async ({ page }) => {
  const f = await inboxFixture({});
  try {
    await page.goto(`${f.base}/`);
    const side = page.getByRole("navigation", { name: "Intents" });
    await expect(side.getByRole("link", { name: /Needs you/ })).toBeVisible();
    await expect(side.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(side.getByRole("link", { name: "Repos" })).toBeVisible();
    await expect(side.locator(".side-repo").first()).toBeVisible();
    await expect(side.locator(".side-meta").first()).toHaveText(/^(queued|spec|plan|code|ship) · /);
    await expect(page.locator(".tabs")).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("frame: Needs you filters the list to what waits on the owner", async ({ page }) => {
  const f = await inboxFixture({});
  try {
    await page.goto(`${f.base}/`);
    const side = page.getByRole("navigation", { name: "Intents" });
    await side.getByRole("link", { name: /Needs you/ }).click();
    await expect(side.getByRole("link", { name: /Needs you/ })).toHaveAttribute("aria-pressed", "true");
    for (const meta of await side.locator(".side-meta").allTextContents())
      expect(meta).toMatch(/waiting on you/);
  } finally {
    await f.stop();
  }
});

test("chat: an intent opens as a chat with its header, card and composer", async ({ page }) => {
  const f = await inboxFixture({});
  try {
    await page.goto(`${f.base}/`);
    const side = page.getByRole("navigation", { name: "Intents" });
    const row = side.locator(".side-row", { hasText: "waiting on you" }).first();
    const title = (await row.locator(".side-title").textContent())!;
    await row.click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByLabel("Message to this intent")).toBeVisible();
    await expect(page.locator(".chat-card")).toBeVisible();
    await page.getByRole("button", { name: "Details" }).click();
    await expect(page.getByRole("complementary", { name: "Details" })).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("chat: typed text survives a live update", async ({ page }) => {
  const f = await inboxFixture({});
  try {
    await page.goto(`${f.base}/`);
    await page
      .getByRole("navigation", { name: "Intents" })
      .locator(".side-row", { hasText: "waiting on you" })
      .first()
      .click();
    const box = page.getByLabel("Message to this intent");
    await box.fill("half a thought");
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await page.waitForTimeout(300);
    await expect(box).toHaveValue("half a thought");
  } finally {
    await f.stop();
  }
});

test("frame: on a phone the sidebar is a drawer", async ({ browser }) => {
  const f = await inboxFixture({});
  const ctx = await browser.newContext({ viewport: PHONE });
  const page = await ctx.newPage();
  try {
    await page.goto(`${f.base}/`);
    const side = page.getByRole("navigation", { name: "Intents" });
    await expect(side).not.toBeInViewport();
    await page.getByRole("button", { name: "Open the intents menu" }).click();
    await expect(side).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(side).not.toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await ctx.close();
    await f.stop();
  }
});
