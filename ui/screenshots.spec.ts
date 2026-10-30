// UI-55, UI-67, UI-68, UI-69, UI-79 to UI-81: every page in light, dark and on a phone, saved for review, with its key
// content checked; the page loads nothing from outside and keeps typed text across an update.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

const PAGES = [
  {
    name: "overview",
    path: "/",
    expect: [
      "things need you",
      "Rate-limit the public API",
      "Merge plan PR",
      "Problems",
      "Working",
      "Up next",
      "Airspace",
    ],
  },
  {
    name: "intent",
    path: "/i/261025-0910-1",
    expect: ["Rate-limit the public API", "Spec", "Plan", "Code", "All moves", "Merge plan PR"],
  },
  {
    name: "stages",
    path: "/i/261024-1130-1?stage=verify&file=verify%2Fverify-1.log",
    expect: ["Running checks", "Round 2", "Check output", "Showing the last 200 of", "2 failing"],
  },
  {
    name: "question",
    path: "/i/261026-0815-2",
    expect: ["Export invoices as CSV", "Towercab recommends", "Send reply"],
  },
  {
    name: "board",
    path: "/board",
    expect: ["Board", "Your plan review", "Faster checkout page", "Readable CI job names", "all time"],
  },
  { name: "repos", path: "/repos", expect: ["Repos", "All", "in progress", "all time", "Add a repo"] },
  {
    name: "repo",
    path: "/repos?repo=web",
    expect: [
      "What people can do",
      "People can export their invoices as a CSV file.",
      "Live",
      "Planned",
      "In progress",
      "Up next",
      "Waiting",
      "Waits for “Faster checkout page” to be done.",
      "Parked",
      "Spend",
      "Refresh from the repo",
    ],
  },
  // UI-140: the old address shows the same page.
  { name: "queue", path: "/queue", expect: ["Repos", "All"] },
  { name: "activity", path: "/activity", expect: ["Activity", "Today", "Moves", "Errors"] },
] as const;

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
      await page.goto(p.path);
      await settle(page);
      for (const text of p.expect) await expect(page.locator("body")).toContainText(text);
      // No page scrolls sideways (UI-68: usable at 360 px).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${p.name} ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `${p.name}-${m.mode}.png`), fullPage: true });
    }
    await ctx.close();
  }
});

test("ui: the built page has no external resources", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") outside.push(r.url());
  });
  for (const p of PAGES) {
    await page.goto(p.path);
    await settle(page);
  }
  expect(outside).toEqual([]);
  const csp = (await page.request.get("/")).headers()["content-security-policy"];
  expect(csp).toContain("default-src 'self'");
  expect(await page.locator("script:not([src])").count()).toBe(0);
});

test("ui: update keeps typed text", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const box = page.locator('[data-intent="261026-0815-2"] textarea');
  await box.fill("One totals row per currency, please.");
  // Open the plan card's menu too: it must stay open.
  const before = await page.locator(".tab-badge").textContent();
  // Pausing changes what the page shows, so it refetches.
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator(".health")).toHaveText(/Paused|Problem/);
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(box).toHaveValue("One totals row per currency, please.");
  expect(await page.locator(".tab-badge").textContent()).toBe(before);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(box).toHaveValue("One totals row per currency, please.");
});

test("ui: activity filters in the URL", async ({ page }) => {
  await page.goto("/activity");
  await settle(page);
  await page.getByRole("button", { name: "Errors" }).click();
  await expect(page).toHaveURL(/kind=errors/);
  await page.getByLabel("Repo").selectOption("infra");
  await expect(page).toHaveURL(/kind=errors&repo=infra|repo=infra.*kind=errors/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Errors" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Repo")).toHaveValue("infra");
  for (const t of await page.locator(".feed-title").allTextContents())
    expect(t).toBe("Rotate log files daily");
});

test("ui: empty page says so", async ({ browser }) => {
  const { fixture, server } = await serveFixture(0, { empty: true });
  try {
    for (const m of [MODES[0], MODES[2]]) {
      const ctx = await browser.newContext({ colorScheme: m.scheme, viewport: m.viewport });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${server.port()}/`);
      await settle(page);
      const body = page.locator("body");
      for (const text of [
        "Nothing needs you.",
        "Nothing is running.",
        "Nothing queued: add an intent to the intents repo.",
        "No problems.",
      ]) {
        await expect(body).toContainText(text);
      }
      await expect(page.locator("#problems")).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, `empty-${m.mode}.png`), fullPage: true });
      await ctx.close();
    }
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: board folds a repo and remembers it", async ({ browser }) => {
  for (const m of [MODES[0], MODES[2]]) {
    const ctx = await browser.newContext({ colorScheme: m.scheme, viewport: m.viewport });
    const page = await ctx.newPage();
    await page.goto("/board");
    await settle(page);
    const toggle = page.locator(".board-toggle:visible", { hasText: "web" });
    const card = page.locator("a.board-card:visible", { hasText: "Faster checkout page" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card).toHaveAttribute("href", "/i/261026-1105-1");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(card).toHaveCount(0);
    // Other repos stay open; the fold survives a reload.
    await expect(page.locator("a.board-card:visible", { hasText: "Rate-limit the public API" })).toHaveCount(
      1,
    );
    await page.reload();
    await settle(page);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(card).toHaveCount(0);
    if (m.mode === "light") {
      // At 1280 px every column fits; narrower, only the board scrolls sideways, and its column headers
      // stay on top while it scrolls down.
      const board = page.locator(".board");
      const sizes = () => board.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
      const wide = await sizes();
      expect(wide.scroll).toBeLessThanOrEqual(wide.client);
      await page.setViewportSize({ width: 960, height: 900 });
      const narrow = await sizes();
      expect(narrow.scroll).toBeGreaterThan(narrow.client);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await board.evaluate((e) => e.scrollTo(e.scrollWidth, e.scrollHeight));
      const head = (await page.locator(".board-col-head").first().boundingBox())!;
      const box = (await board.boundingBox())!;
      expect(Math.abs(head.y - box.y)).toBeLessThanOrEqual(2);
    }
    await toggle.click();
    await expect(card).toHaveCount(1);
    await ctx.close();
  }
  // Without storage the board still folds, until the page reloads.
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("storage is off");
      },
    });
  });
  const page = await ctx.newPage();
  await page.goto("/board");
  await settle(page);
  const toggle = page.locator(".board-toggle:visible", { hasText: "web" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await ctx.close();
});

// The hit area: the plane itself loops, so it is never still enough to point at.
const CI_PLANE = '.air-target[aria-label^="Faster checkout page"] .air-hit';

test("ui: airspace card opens under a plane", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await settle(page);
    const plane = page.locator(CI_PLANE);
    await plane.hover();
    const card = page.locator(".air-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Faster checkout page");
    await expect(card).toContainText("waiting on ci");
    await expect(card).toContainText("Waiting for CI");
    const open = card.getByRole("link", { name: "Open intent ›" });
    await expect(open).toHaveAttribute("href", "/i/261026-1105-1");
    const p = (await plane.boundingBox())!;
    const c = (await card.boundingBox())!;
    expect(c.y).toBeGreaterThan(p.y + p.height);
    const air = (await page.locator(".air").boundingBox())!;
    await page.screenshot({
      path: join(SHOTS, `airspace-card-${scheme}.png`),
      clip: { x: air.x - 8, y: air.y - 8, width: air.width + 16, height: air.height + 200 },
    });
    // Moving onto the card keeps it open; its link opens the intent.
    await card.hover();
    await page.waitForTimeout(400);
    await expect(card).toBeVisible();
    await open.click();
    await expect(page).toHaveURL(/\/i\/261026-1105-1$/);
    await ctx.close();
  }
  // Keyboard: focus opens the card, Escape closes it.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await settle(page);
  await page.locator(CI_PLANE).locator("xpath=..").focus();
  await expect(page.locator(".air-card")).toContainText("Faster checkout page");
  await page.keyboard.press("Escape");
  await expect(page.locator(".air-card")).toHaveCount(0);
  // The landed block sums today.
  await page.locator('.air-target[aria-label$="landed today"] .air-hit').hover();
  await expect(page.locator(".air-card")).toContainText("landed today");
  await ctx.close();
});

test("ui: airspace can be hidden", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await expect(page.locator(".air")).toBeVisible();
  await page.getByRole("button", { name: "Hide airspace" }).click();
  await expect(page.locator(".air")).toHaveCount(0);
  await expect(page.locator(".air-collapsed")).toContainText("in flight");
  await page.reload();
  await settle(page);
  await expect(page.locator(".air")).toHaveCount(0);
  await page.getByRole("button", { name: "Show airspace" }).click();
  await expect(page.locator(".air")).toBeVisible();
  await page.reload();
  await settle(page);
  await expect(page.locator(".air")).toBeVisible();
});

test("ui: airspace motion stops with reduced motion", async ({ browser }) => {
  const animated = async (reducedMotion: "reduce" | "no-preference") => {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await page.goto("/");
    await settle(page);
    await page.locator(CI_PLANE).hover();
    await expect(page.locator(".air-card")).toBeVisible();
    const found = await page.$$eval(".air-section *", (els) =>
      els.flatMap((e) => {
        const s = getComputedStyle(e);
        const moving = s.animationName !== "none" || Number.parseFloat(s.transitionDuration) > 0;
        return moving ? [e.getAttribute("class") ?? e.tagName] : [];
      }),
    );
    await ctx.close();
    return found;
  };
  expect(await animated("no-preference")).not.toEqual([]);
  expect(await animated("reduce")).toEqual([]);
});
