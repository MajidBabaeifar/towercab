// UI-259, UI-260, UI-263, UI-264, UI-266: the Inbox page, on a desktop and on a phone.

import { expect, test } from "@playwright/test";
import { inboxFixture, PHONE, selectedKey, settle } from "./inbox-helpers.ts";

const PLAN = "261025-0910-1";

test("ui: the inbox opens with the first item selected and posts nothing", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    expect(await selectedKey(page)).toBe("proposed-201");
    await expect(page.locator(".inbox-detail #proposed-201")).toBeVisible();
    await expect(page.locator(".inbox-row")).toHaveCount(9);
    // Selecting is not acting: Enter, with the page's own selection, opens and posts nothing.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    expect(f.fixture.calls).toEqual([]);
  } finally {
    await f.stop();
  }
});

test("ui: the inbox card has the actions of the needs-you card", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${PLAN}`);
    await settle(page);
    const card = page.locator(`.inbox-detail .needs-card[data-intent="${PLAN}"]`);
    await expect(card.getByRole("button", { name: "Merge plan PR" })).toBeVisible();
    await expect(card.getByRole("button", { name: "More actions" })).toBeVisible();
    await card.getByRole("button", { name: "Merge plan PR" }).click();
    await expect.poll(() => f.fixture.calls).toEqual([{ action: "merge", intent: PLAN }]);
  } finally {
    await f.stop();
  }
});

test("ui: an inbox link opens its item", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${PLAN}`);
    await settle(page);
    expect(await selectedKey(page)).toBe(PLAN);
    await expect(page.locator("#inbox-detail-title")).toHaveText("Rate-limit the public API");
    await page.locator("#inbox-row-proposed-205").click();
    await expect(page).toHaveURL(`${f.base}/inbox/proposed-205`);
    expect(await selectedKey(page)).toBe("proposed-205");
  } finally {
    await f.stop();
  }
});

test("ui: the inbox filter matches title, repo, id and PR number", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    const filter = page.getByLabel("Filter the inbox");
    const count = () => page.locator(".inbox-row").count();
    await filter.fill("RATE-LIMIT");
    await expect.poll(count).toBe(1);
    await filter.fill("web");
    await expect.poll(count).toBeGreaterThan(1);
    await filter.fill(PLAN);
    await expect.poll(count).toBe(1);
    await filter.fill("#203");
    await expect.poll(count).toBe(1);
    await expect(page.locator(".inbox-row")).toContainText("chart library");
    await expect(page).toHaveURL(/\?q=%23203$/);
    await filter.fill("zzz");
    await expect.poll(count).toBe(0);
    // `/` focuses the filter.
    await filter.fill("");
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("/");
    await expect(filter).toBeFocused();
  } finally {
    await f.stop();
  }
});

test("ui: filtering does not change the needs count", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    const bar = page.locator(".counts a").first();
    await expect(bar).toHaveText("9 need you");
    await page.getByLabel("Filter the inbox").fill("rate");
    await expect(page.locator(".inbox-row")).toHaveCount(1);
    await expect(bar).toHaveText("9 need you");
    await expect(page.locator(".inbox-count")).toContainText("9 need you");
    await expect(page.locator(".inbox-shown")).toHaveText("1 of 9");
  } finally {
    await f.stop();
  }
});

test("ui: the page sends seen only after it was visible for 3 seconds", async ({ browser }) => {
  const f = await inboxFixture();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const seen: number[] = [];
    await page.route("**/api/actions", async (route) => {
      if (route.request().postData()?.includes('"seen"')) seen.push(Date.now());
      await route.continue();
    });
    const t0 = Date.now();
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.waitForTimeout(1500);
    expect(seen).toEqual([]);
    await expect.poll(() => seen.length, { timeout: 6000 }).toBe(1);
    expect(seen[0]! - t0).toBeGreaterThanOrEqual(3000);
    expect(f.fixture.db.meta("inbox:last_visit")).not.toBeNull();
    await ctx.close();
    // A page closed at once marks nothing.
    const quick = await (await browser.newContext()).newPage();
    f.fixture.db.delMeta("inbox:last_visit");
    await quick.goto(`${f.base}/`);
    await settle(quick);
    await quick.close();
    expect(f.fixture.db.meta("inbox:last_visit")).toBeNull();
  } finally {
    await f.stop();
  }
});

test("ui: snoozing from the inbox moves the item under snoozed", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${PLAN}`);
    await settle(page);
    await page.keyboard.press("s");
    // `s` only opens the choices; nothing is snoozed yet.
    await expect(page.getByRole("dialog", { name: "Snooze" })).toBeVisible();
    expect(f.fixture.db.meta(`inbox:snooze:${PLAN}`)).toBeNull();
    await page.getByRole("button", { name: "1 hour" }).click();
    await expect(page.locator(`#inbox-row-${PLAN}`)).toHaveCount(1);
    await expect(page.getByRole("heading", { name: /^Snoozed/ })).toBeVisible();
    await expect(page.locator(".inbox-count")).toContainText("9 need you · 1 snoozed");
    await expect(page.locator(".counts a").first()).toHaveText("9 need you");
    expect(await page.locator(`[aria-label="Inbox"] #inbox-row-${PLAN}`).count()).toBe(0);
    await page.getByRole("button", { name: "Unsnooze" }).click();
    await expect(page.locator(`[aria-label="Inbox"] #inbox-row-${PLAN}`)).toHaveCount(1);
  } finally {
    await f.stop();
  }
});

test("ui: a wait newer than the last visit shows a new marker", async ({ page }) => {
  const f = await inboxFixture();
  try {
    // The visit falls two days ago: the proposals newer than that are new.
    f.fixture.db.setMeta("inbox:last_visit", String(Date.now() / 1000 - 86_400));
    await page.goto(`${f.base}/`);
    await settle(page);
    const marked = await page.locator(".chip-new").count();
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(9);
    await expect(page.locator(".inbox-count")).toContainText(`${marked} new`);
    // Opening an item clears its own marker.
    const id = await page
      .locator(".inbox-row", { has: page.locator(".chip-new") })
      .first()
      .getAttribute("id");
    const row = page.locator(`[id="${id}"]`);
    await row.click();
    await expect(row.locator(".chip-new")).toHaveCount(0);
    await expect(page.locator(".chip-new")).toHaveCount(marked - 1);
  } finally {
    await f.stop();
  }
});

test("ui: on a phone the inbox is a list that opens the card", async ({ browser }) => {
  const f = await inboxFixture();
  try {
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page.locator(".inbox-row").first()).toBeVisible();
    await expect(page.locator(".inbox-detail")).toHaveCount(0);
    const rowBox = (await page.locator(".inbox-row").first().boundingBox())!;
    expect(rowBox.height).toBeGreaterThanOrEqual(44);
    await page.locator(`#inbox-row-${PLAN}`).click();
    await expect(page).toHaveURL(`${f.base}/inbox/${PLAN}`);
    await expect(page.locator(".inbox-detail")).toBeVisible();
    await expect(page.locator(".inbox-list")).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Back to the inbox" }).click();
    await expect(page.locator(".inbox-list")).toBeVisible();
    await expect(page.locator(".inbox-detail")).toHaveCount(0);
    // The browser's own back button does the same.
    await page.locator(`#inbox-row-${PLAN}`).click();
    await expect(page.locator(".inbox-detail")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".inbox-list")).toBeVisible();
    await ctx.close();
  } finally {
    await f.stop();
  }
});

test("ui: going back keeps the inbox scroll position", async ({ browser }) => {
  const f = await inboxFixture({ crowded: true });
  try {
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${f.base}/`);
    await settle(page);
    const rows = page.locator(".inbox-row");
    const last = rows.nth((await rows.count()) - 1);
    await last.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    expect(before).toBeGreaterThan(200);
    await last.click();
    await expect(page.locator(".inbox-detail")).toBeVisible();
    await page.getByRole("button", { name: "Back to the inbox" }).click();
    await expect(page.locator(".inbox-list")).toBeVisible();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before - 5);
    await ctx.close();
  } finally {
    await f.stop();
  }
});

test("ui: the root page is the inbox and the overview has its own address", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page.locator("h1")).toHaveText("Inbox");
    const tabs = page.getByRole("navigation", { name: "Pages" }).locator("a.tab");
    await expect(tabs).toHaveText([/^Inbox/, "Overview", "Board", "Repos", "Activity"]);
    await expect(tabs.first()).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await expect(page).toHaveURL(`${f.base}/overview`);
    await expect(page.locator("main.overview")).toBeVisible();
    await expect(page.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The address works on its own, and /focus lands on the inbox.
    await page.goto(`${f.base}/overview`);
    await expect(page.locator("main.overview")).toBeVisible();
    await page.goto(`${f.base}/focus`);
    await expect(page).toHaveURL(`${f.base}/`);
    await expect(page.locator("h1")).toHaveText("Inbox");
  } finally {
    await f.stop();
  }
});

test("ui: old overview fragments open the inbox item", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/#proposed-205`);
    await settle(page);
    await expect(page).toHaveURL(`${f.base}/inbox/proposed-205`);
    expect(await selectedKey(page)).toBe("proposed-205");
    await page.goto(`${f.base}/#needs-${PLAN}`);
    await settle(page);
    await expect(page).toHaveURL(`${f.base}/inbox/${PLAN}`);
    // An item that no longer waits lands on the overview.
    await page.goto(`${f.base}/#proposed-999`);
    await expect(page).toHaveURL(`${f.base}/overview#proposed-999`);
    await expect(page.locator("main.overview")).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: the tab title keeps the needs count", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page).toHaveTitle("(9) Towercab");
    await page.goto(`${f.base}/overview`);
    await expect(page).toHaveTitle("(9) Towercab · Overview");
    await page.goto(`${f.base}/board`);
    await expect(page).toHaveTitle(/^\(9\) Towercab/);
    await f.stop();
    const empty = await inboxFixture({ empty: true });
    try {
      await page.goto(`${empty.base}/`);
      await expect(page).toHaveTitle("Towercab");
    } finally {
      await empty.stop();
    }
  } catch (e) {
    await f.stop().catch(() => {});
    throw e;
  }
});
