// UI-192 to UI-197: the Focus tab in Chromium: one wait at a time, the next one after an action, a phone
// and the keyboard.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { IDS, serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

const noSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("ui: the focus tab shows one wait", async ({ page }) => {
  await page.goto("/focus");
  await settle(page);
  await expect(page.getByRole("link", { name: "Focus" })).toHaveAttribute("aria-current", "page");
  const tabs = await page.locator(".tabs-inner .tab").allTextContents();
  expect(tabs.map((t) => t.replace(/\d+$/, ""))).toEqual(["Overview", "Board", "Focus", "Repos", "Activity"]);
  await expect(page.locator("h1")).toHaveText("Rate-limit the public API");
  await expect(page.locator(".focus-repo")).toHaveText("api");
  await expect(page.locator(".focus-overview")).toContainText("A single client sent 40,000 requests");
  await expect(page.locator(".focus-history")).toContainText("600 requests a minute");
  await expect(page.locator(".needs-card")).toHaveCount(1);
  await expect(page.locator(".focus-more")).toHaveText("3 more waiting");
  // The others are counted, not listed.
  await expect(page.locator("main")).not.toContainText("Export invoices as CSV");
  await expect(page).toHaveTitle(/Focus/);
});

test("ui: focus offers the actions of the needs-you card", async ({ page }) => {
  await page.goto("/focus");
  await settle(page);
  const card = page.locator(".needs-card");
  await expect(card.getByRole("button", { name: "Merge plan PR" })).toBeVisible();
  await card.getByRole("button", { name: "More actions" }).click();
  await expect(card.getByRole("menuitem", { name: /Start over/ })).toBeVisible();
  await expect(card.getByRole("menuitem", { name: /Drop/ })).toBeVisible();
  await expect(card).toContainText("What the worker may reach beyond the repo");
});

test("ui: focus has no action the needs-you card lacks", async ({ page }) => {
  const buttons = (root: ReturnType<Page["locator"]>) =>
    root.evaluate((el) =>
      [...el.querySelectorAll("button, a[href]")].map(
        (b) => (b.textContent ?? "").trim() || b.getAttribute("aria-label"),
      ),
    );
  await page.goto("/");
  await settle(page);
  const onOverview = await buttons(page.locator(`.needs-card[data-intent="${IDS.plan}"]`));
  await page.goto("/focus");
  await settle(page);
  const onFocus = await buttons(page.locator(".needs-card"));
  // The overview's card also links its title; Focus shows the title as its heading.
  expect(onFocus).toEqual(onOverview.filter((b) => b !== "Rate-limit the public API"));
});

test("ui: focus moves to the next wait after an action", async ({ page }) => {
  await page.goto("/focus");
  await settle(page);
  await page.locator(".needs-card").getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Start over/ }).click();
  // The next by priority takes its place at once, with the heading ready for the keyboard.
  const title = page.locator("h1");
  await expect(title).toHaveText("Export invoices as CSV");
  await expect(title).toBeFocused();
  await expect(page.locator(".needs-card")).toHaveCount(1);
  await expect(page.locator(".needs-card")).toHaveAttribute("data-intent", IDS.question);
  await expect(page.locator(".focus-more")).toHaveText("2 more waiting");
  await expect(page.locator(".focus-history")).toContainText("Plan");
  // Answering a question moves on too.
  await page.getByRole("button", { name: "One totals row per currency" }).click();
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(title).toHaveText("Rewrite the getting-started guide");
  await expect(page.locator(".focus-more")).toHaveText("1 more waiting");
});

test("ui: focus moves on when a wait ends elsewhere", async ({ page }) => {
  const { fixture, server } = await serveFixture(0);
  try {
    await page.goto(`http://localhost:${server.port()}/focus`);
    await settle(page);
    await expect(page.locator("h1")).toHaveText("Rate-limit the public API");
    // The loop moves the mission on (the owner merged the PR on GitHub, say).
    fixture.db.run(
      "UPDATE missions SET stage = 'build', waiting = NULL, updated = updated + 1 WHERE intent = ?",
      IDS.plan,
    );
    await expect(page.locator("h1")).toHaveText("Export invoices as CSV");
    await expect(page.locator(".focus-more")).toHaveText("2 more waiting");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: focus says nothing needs you when empty", async ({ page }) => {
  const { fixture, server } = await serveFixture(0, { empty: true });
  try {
    await page.goto(`http://localhost:${server.port()}/focus`);
    await settle(page);
    await expect(page.locator("main")).toContainText("Nothing needs you.");
    await expect(page.locator(".focus-more")).toHaveCount(0);
    await expect(page.locator(".needs-card")).toHaveCount(0);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: focus works by keyboard", async ({ page }) => {
  await page.goto("/focus");
  await settle(page);
  await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
  // Tab reaches the merge button in reading order, with a visible focus ring.
  const merge = page.getByRole("button", { name: "Merge plan PR" });
  let reached = false;
  for (let k = 0; k < 40 && !reached; k++) {
    await page.keyboard.press("Tab");
    reached = await merge.evaluate((el) => el === document.activeElement);
  }
  expect(reached, "Tab reaches the merge button").toBe(true);
  const ring = await merge.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: Number.parseFloat(s.outlineWidth) };
  });
  expect(ring.style).not.toBe("none");
  expect(ring.width).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(page.locator("h1")).toHaveText("Export invoices as CSV");
  await expect(page.locator("h1")).toBeFocused();
  await expect(page.locator('[aria-live="polite"]')).toContainText("Export invoices as CSV");
});

test("ui: focus works on a phone", async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 740 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto("/focus");
  await settle(page);
  await page.locator(".needs-card").getByRole("button", { name: "More actions" }).click();
  expect(await noSideways(page), "Focus scrolls sideways at 360 px").toBeLessThanOrEqual(0);
  const heights = await page
    .locator(".focus-page button:visible")
    .evaluateAll((els) => els.map((e) => [e.textContent?.trim() ?? "", e.getBoundingClientRect().height]));
  for (const [name, h] of heights) expect(h, `${name} is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
  await ctx.close();
});

test("ui: screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { proposed: true });
  const base = `http://localhost:${server.port()}`;
  const modes = [
    { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
    { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
    { mode: "mobile", scheme: "light", viewport: { width: 375, height: 812 } },
  ] as const;
  try {
    for (const m of modes) {
      const ctx = await browser.newContext({
        colorScheme: m.scheme,
        viewport: m.viewport,
        deviceScaleFactor: m.mode === "mobile" ? 2 : 1,
        isMobile: m.mode === "mobile",
        hasTouch: m.mode === "mobile",
      });
      const page = await ctx.newPage();
      await page.goto(`${base}/focus`);
      await settle(page);
      // The proposal and the plan wait are both 14; the proposal has waited longer, so it shows first.
      await expect(page.locator("h1")).toHaveText("Export invoices as a spreadsheet");
      await expect(page.locator(".proposed-card")).toBeVisible();
      await expect(page.locator(".focus-more")).toHaveText("8 more waiting");
      expect(await noSideways(page), `focus ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `focus-proposed-${m.mode}.png`), fullPage: true });
      // Accept it from here: the next one takes its place.
      await page.getByRole("button", { name: "Accept" }).click();
      await expect(page.locator("h1")).toHaveText("Rate-limit the public API");
      await expect(page.locator(".focus-history")).toContainText("Spec");
      expect(await noSideways(page), `focus ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `focus-${m.mode}.png`), fullPage: true });
      await ctx.close();
      // Put the proposal back for the next mode.
      fixture.state.proposed = {
        ...fixture.state.proposed,
        list: (await import("./fixture.ts")).proposals(Date.now() / 1000),
      };
    }
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
