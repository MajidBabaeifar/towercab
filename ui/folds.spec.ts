// UI-267: every long list has a header with a count and a toggle; the state is remembered per browser.

import { expect, test } from "@playwright/test";
import { inboxFixture, PHONE, settle } from "./inbox-helpers.ts";

const head = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}$`) });

test("ui: every long list has a header with a count and a toggle", async ({ page }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".overview");
    for (const [title, count] of [
      ["Working", /^\d+$/],
      ["Up next", /^\d+$/],
    ] as const) {
      const section = page.locator("section", { has: head(page, title) });
      await expect(head(page, title)).toHaveAttribute("aria-expanded", "true");
      await expect(head(page, title)).toHaveAttribute("aria-controls", /.+/);
      await expect(section.locator(".section-head .count")).toHaveText(count);
    }
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(head(page, "Needs you")).toHaveAttribute("aria-expanded", "true");
    await page.goto(`${f.base}/repos?repo=web`);
    await expect(head(page, "Proposed")).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: a folded list still shows its count", async ({ page }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".overview");
    const section = page.locator("section", { has: head(page, "Working") });
    const n = await section.locator(".section-head .count").textContent();
    await head(page, "Working").click();
    await expect(head(page, "Working")).toHaveAttribute("aria-expanded", "false");
    await expect(section.locator(".section-head .count")).toHaveText(n ?? "");
    await expect(section.locator(".rows")).toBeHidden();
    await head(page, "Working").click();
    await expect(section.locator(".rows")).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: lists start open", async ({ page }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".overview");
    for (const t of ["Working", "Up next"])
      await expect(head(page, t)).toHaveAttribute("aria-expanded", "true");
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(head(page, "Needs you")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".inbox-row").first()).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: fold state is remembered per browser", async ({ browser }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".overview");
    await head(page, "Up next").click();
    await page.reload();
    await page.waitForSelector(".overview");
    await expect(head(page, "Up next")).toHaveAttribute("aria-expanded", "false");
    await expect(head(page, "Working")).toHaveAttribute("aria-expanded", "true");
    await ctx.close();
    // Another browser has its own memory: the list is open there.
    const other = await (await browser.newContext()).newPage();
    await other.goto(`${f.base}/overview`);
    await other.waitForSelector(".overview");
    await expect(head(other, "Up next")).toHaveAttribute("aria-expanded", "true");
  } finally {
    await f.stop();
  }
});

test("ui: fold state survives a live update", async ({ page }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".overview");
    await head(page, "Up next").click();
    await head(page, "Working").focus();
    // A pause on the server changes what the page shows, so it refetches without anyone clicking.
    f.fixture.state.paused = true;
    await expect(page.locator(".topbar").getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(head(page, "Up next")).toHaveAttribute("aria-expanded", "false");
    await expect(head(page, "Working")).toHaveAttribute("aria-expanded", "true");
    await expect(head(page, "Working")).toBeFocused();
  } finally {
    await f.stop();
  }
});

test("ui: fold toggle works by keyboard and on a phone", async ({ browser }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".overview");
    const toggle = head(page, "Working");
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await ctx.close();
  } finally {
    await f.stop();
  }
});

test("ui: fold state works without browser storage", async ({ browser }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("no storage");
        },
      });
    });
    const page = await ctx.newPage();
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".overview");
    await expect(head(page, "Working")).toHaveAttribute("aria-expanded", "true");
    await head(page, "Working").click();
    await expect(head(page, "Working")).toHaveAttribute("aria-expanded", "false");
    await ctx.close();
  } finally {
    await f.stop();
  }
});
