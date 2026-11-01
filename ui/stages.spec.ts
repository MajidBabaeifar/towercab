// UI-73 to UI-77: the stage map of the intent page in a real browser, against the fixture's code
// intent (261024-1130-1): two attempts, a repair loop, a skipped proof and a wait on the owner.

import { expect, type Page, test } from "@playwright/test";

const CODE = "/i/261024-1130-1";
const STAGES = [
  "Writing the spec",
  "Your spec review",
  "Planning",
  "Your plan review",
  "Building",
  "Running checks",
  "Proving the tests",
  "Opening the PR",
  "CI",
  "Reviewing",
  "Deciding",
  "Your code review",
  "Merging",
];

async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

const nodes = (page: Page) => page.locator("ol.smap-list > li");
const node = (page: Page, name: string) => page.locator("ol.smap-list > li", { hasText: name }).first();

test("ui: stage map shows every stage and its outcome", async ({ page }) => {
  await page.goto(CODE);
  await settle(page);
  await expect(nodes(page)).toHaveCount(STAGES.length);
  expect(await page.locator("ol.smap-list > li .smap-name").allTextContents()).toEqual(STAGES);
  // Each node says its outcome in words, with an icon, and the time it took.
  await expect(node(page, "Writing the spec")).toContainText("passed");
  await expect(node(page, "Running checks")).toContainText("passed");
  await expect(node(page, "Your code review")).toContainText("waiting on you");
  await expect(node(page, "Merging")).toContainText("not reached");
  await expect(node(page, "Building").locator(".smap-time")).toHaveText(/\d+ (h|min|d)/);
  expect(await node(page, "Building").locator("svg").count()).toBeGreaterThan(0);
  // The two totals sit under the map.
  await expect(page.locator(".smap-totals")).toContainText("Towercab working");
  await expect(page.locator(".smap-totals")).toContainText("Waiting on you");
});

test("ui: stage map marks the current and skipped stages", async ({ page }) => {
  await page.goto(CODE);
  await settle(page);
  const current = page.locator('ol.smap-list button[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("Your code review");
  await expect(node(page, "Proving the tests")).toContainText("skipped");
  await expect(node(page, "Proving the tests")).toContainText("no proof needed");
  await expect(node(page, "Merging")).toHaveClass(/smap-idle/);
  // A wait on the owner uses the "Needs you" look.
  await expect(node(page, "Your code review")).toHaveClass(/smap-wait/);
  // The spinner is the only motion, and it stops with reduced motion.
  await page.goto("/i/261026-0700-1");
  await settle(page);
  const spinner = page.locator("ol.smap-list .smap-btn .spin");
  await expect(spinner).toHaveCount(1);
  expect(await spinner.evaluate((e) => getComputedStyle(e).animationName)).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await spinner.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
});

test("ui: map shows rounds and return links", async ({ page }) => {
  await page.goto(CODE);
  await settle(page);
  const building = node(page, "Building");
  await expect(building).toContainText("Round 1");
  await expect(building).toContainText("Round 2");
  const checks = node(page, "Running checks");
  await expect(checks).toContainText("Round 1 · red");
  await expect(checks).toContainText("Round 2 · passed");
  // The step back is written as text, so it reads without the diagram.
  await expect(checks.locator(".smap-returns")).toContainText(
    "sent back to Building: checks failed: 2 tests red in docs/links.test.ts",
  );
});

test("ui: stage panel opens the stage that matters", async ({ page }) => {
  // A wait on the owner comes first.
  await page.goto(CODE);
  await settle(page);
  await expect(page.locator(".smap-panel .smap-panel-title")).toHaveText("Your code review");
  await expect(node(page, "Your code review").getByRole("button")).toHaveAttribute("aria-expanded", "true");
  // A question is a wait on the owner too.
  await page.goto("/i/261026-0815-2");
  await settle(page);
  await expect(page.locator(".smap-panel .smap-panel-title")).toHaveText("Your answer");
  // Otherwise the last red stage: this one is building again after checks failed.
  await page.goto("/i/261026-0700-1");
  await settle(page);
  const open = page.locator('ol.smap-list button[aria-expanded="true"]');
  await expect(open).toHaveCount(1);
  await expect(open).toContainText("Running checks");
  await expect(open).toContainText("red");
});

test("ui: stage and file are in the URL", async ({ page }) => {
  await page.goto(CODE);
  await settle(page);
  await node(page, "Running checks").getByRole("button").click();
  await expect(page).toHaveURL(/stage=verify/);
  await expect(page.locator(".smap-panel-title")).toHaveText("Running checks");
  // The panel groups the files by round, with plain names and sizes.
  await expect(page.locator(".smap-group h4")).toHaveText(["Round 1", "Round 2"]);
  await page.locator(".file-btn", { hasText: "Check output" }).first().click();
  await expect(page).toHaveURL(/stage=verify&file=verify%2Fverify-1\.log/);
  await expect(page.locator(".viewer-text")).toContainText("2 failing");
  // A shared link, or a reload, opens the same stage and file.
  await page.reload();
  await settle(page);
  await expect(page.locator(".smap-panel-title")).toHaveText("Running checks");
  await expect(page.locator(".viewer-text")).toContainText("2 failing");
  // Claude's settings, system prompt and guard file are folded under Details.
  await page.goto(`${CODE}?stage=design`);
  await settle(page);
  const details = page.locator("details.smap-details").first();
  await expect(details.locator("summary")).toHaveText("Details");
  await expect(details).not.toHaveAttribute("open", "");
});

test("ui: log viewer shows the last 200 lines", async ({ page }) => {
  await page.goto(`${CODE}?stage=verify&file=verify%2Fverify-1.log`);
  await settle(page);
  const text = page.locator(".viewer-text");
  await expect(page.locator(".viewer-cut")).toContainText("Showing the last 200 of");
  expect((await text.textContent())?.split("\n").length).toBe(200);
  await expect(text).not.toContainText("link 1 resolves");
  const raw = page.getByRole("link", { name: "Open raw" });
  await expect(raw).toHaveAttribute("href", /\/api\/runs\/261024-1130-1\/verify\/verify-1\.log$/);
  await expect(raw).toHaveAttribute("target", "_blank");
  await page.getByRole("button", { name: /Show all/ }).click();
  await expect(text).toContainText("link 1 resolves");
  // JSON results are pretty-printed.
  await page.goto(`${CODE}?stage=build&file=build%2Fworker-1.json`);
  await settle(page);
  await expect(page.locator(".viewer-text")).toContainText('"type": "result"');
});

test("ui: update keeps the open log", async ({ page }) => {
  await page.goto(`${CODE}?stage=verify&file=verify%2Fverify-1.log`);
  await settle(page);
  const text = page.locator(".viewer-text");
  await text.evaluate((e) => {
    e.scrollTop = 40;
  });
  const before = await text.evaluate((e) => e.scrollTop);
  expect(before).toBeGreaterThan(0);
  // Pausing changes what the page shows, so it refetches.
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator(".topbar").getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(page).toHaveURL(/stage=verify&file=verify%2Fverify-1\.log/);
  await expect(text).toContainText("2 failing");
  expect(await text.evaluate((e) => e.scrollTop)).toBe(before);
  await page.locator(".topbar").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
});

test("ui: attempt switcher drives the map", async ({ page }) => {
  await page.goto(CODE);
  await settle(page);
  const group = page.getByRole("group", { name: "Attempt" });
  await expect(group.getByRole("button", { name: "Attempt 2" })).toHaveAttribute("aria-pressed", "true");
  await group.getByRole("button", { name: "Attempt 1" }).click();
  await expect(page).toHaveURL(/attempt=1/);
  await expect(node(page, "Writing the spec")).toContainText("Round 2");
  await expect(node(page, "Your code review")).toContainText("not reached");
  await expect(page.locator('ol.smap-list button[aria-current="step"]')).toHaveCount(0);
  await group.getByRole("button", { name: "Attempt 2" }).click();
  await expect(page).not.toHaveURL(/attempt=/);
  await expect(node(page, "Your code review")).toContainText("waiting on you");
  // An intent with one attempt has no switcher.
  await page.goto("/i/261026-0815-2");
  await settle(page);
  await expect(page.getByRole("group", { name: "Attempt" })).toHaveCount(0);
});

test("ui: intent page has no step-time or run-files section", async ({ page }) => {
  await page.goto(CODE);
  await settle(page);
  const body = page.locator("body");
  await expect(body).not.toContainText("Time per step");
  await expect(body).not.toContainText("Run files");
  // The moves stay, folded under the map.
  const moves = page.locator("details.moves");
  await expect(moves.locator("summary")).toContainText("All moves");
  await expect(moves.locator("ol.timeline")).toBeHidden();
  await moves.locator("summary").click();
  await expect(moves.locator("ol.timeline")).toBeVisible();
  // The map sits above the page's columns, under the three PRs.
  const prs = await page.locator(".prs").boundingBox();
  const map = await page.locator(".smap").boundingBox();
  const cols = await page.locator(".cols").boundingBox();
  expect(prs?.y).toBeLessThan(map?.y ?? 0);
  expect(map?.y).toBeLessThan(cols?.y ?? 0);
});

test("ui: stage map is keyboard and screen reader friendly", async ({ page }) => {
  await page.goto(CODE);
  await settle(page);
  const list = page.getByRole("list", { name: "Stages in pipeline order" });
  const buttons = list.locator("button.smap-btn");
  await expect(buttons).toHaveCount(STAGES.length);
  // Outcome and time are in the accessible name; the open stage is expanded.
  await expect(buttons.nth(5)).toHaveAttribute("aria-label", /^Running checks: passed, .+, 2 rounds/);
  await expect(buttons.nth(11)).toHaveAttribute("aria-expanded", "true");
  await expect(buttons.nth(0)).toHaveAttribute("aria-expanded", "false");
  // Arrow keys move between stages; Enter opens one.
  await buttons.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(buttons.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(buttons.nth(STAGES.length - 1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(buttons.nth(0)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(buttons.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/stage=design/);
  // A phone gets a vertical stepper with the files inline under the stage, and no sideways scroll.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${CODE}?stage=verify`);
  await settle(page);
  const first = await nodes(page).nth(0).boundingBox();
  const second = await nodes(page).nth(1).boundingBox();
  expect(second?.y).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0) - 1);
  expect(Math.abs((second?.x ?? 0) - (first?.x ?? 0))).toBeLessThan(2);
  await expect(node(page, "Running checks").locator(".smap-panel")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});
