// UI-189 to UI-191: the Needs you cards on the overview fold to one line, the page remembers it in
// this browser, and a card whose ask changes opens again.

import { expect, type Page, test } from "@playwright/test";

const PLAN = "261025-0910-1";
const QUESTION = "261026-0815-2";
const card = (page: Page, id: string) => page.locator(`.needs-card[data-intent="${id}"]`);
const toggle = (page: Page, id: string) => card(page, id).locator(".fold-toggle");

async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

/** Serves /api/state with every card's ask changed by `change.suffix`; it reads the real answer first. */
async function changeable(page: Page) {
  const change = { suffix: "" };
  await page.route("**/api/state", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (change.suffix) for (const c of body.needs) if (c.intent === QUESTION) c.ask += change.suffix;
    await route.fulfill({ response: res, json: body });
  });
  return change;
}

/** Starts the plan card over: an action makes the page read its data again, like a live update. */
async function refetch(page: Page) {
  await card(page, PLAN).getByRole("button", { name: "More actions" }).click();
  await card(page, PLAN)
    .getByRole("menuitem", { name: /Start over/ })
    .click();
  await page.waitForLoadState("networkidle");
}

test("ui: needs-you card folds and opens", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const q = card(page, QUESTION);
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "true");
  await expect(q.locator(".options")).toBeVisible();
  await q.locator("textarea[name=reply]").fill("a draft");
  await toggle(page, QUESTION).click();
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "false");
  await expect(q.locator(".options")).toBeHidden();
  await expect(q.locator("textarea[name=reply]")).toBeHidden();
  await expect(q.locator(".risk, .brief, .access")).toBeHidden();
  // Other cards stay open.
  await expect(toggle(page, PLAN)).toHaveAttribute("aria-expanded", "true");
  await toggle(page, QUESTION).click();
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "true");
  await expect(q.locator("textarea[name=reply]")).toHaveValue("a draft");
  // The intent page's card has no toggle.
  await page.goto(`/i/${QUESTION}`);
  await settle(page);
  await expect(page.locator(".needs-card")).toHaveCount(1);
  await expect(page.locator(".fold-toggle")).toHaveCount(0);
});

test("ui: fold toggle is keyboard operable", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const t = toggle(page, QUESTION);
  await t.focus();
  await page.keyboard.press("Enter");
  await expect(t).toHaveAttribute("aria-expanded", "false");
  await expect(t).toBeFocused();
  await page.keyboard.press("Space");
  await expect(t).toHaveAttribute("aria-expanded", "true");
  await expect(t).toHaveAccessibleName(/^Fold /);
});

test("ui: folded needs-you card shows title, repo, ask and age", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  const q = card(page, QUESTION);
  const open = {
    title: await q.locator(".card-title").innerText(),
    repo: (await q.locator(".card-titles .meta").innerText()).split(" · ")[0] ?? "",
    ask: await q.locator(".ask").innerText(),
  };
  await toggle(page, QUESTION).click();
  const line = q.locator(".fold-line");
  await expect(line.locator(".fold-title")).toHaveText(open.title);
  await expect(line.locator(".fold-repo")).toHaveText(open.repo);
  await expect(line.locator(".fold-ask")).toHaveText(open.ask);
  await expect(line.locator(".fold-age time")).toBeVisible();
  for (const size of [
    { width: 1280, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    const box = (await q.boundingBox())!;
    const one = await line.evaluate((e) => e.getBoundingClientRect().height <= 24);
    expect(one).toBe(true);
    expect(box.height).toBeLessThan(80);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
  }
});

test("ui: folded needs-you cards are remembered", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await settle(page);
  await toggle(page, QUESTION).click();
  await page.reload();
  await settle(page);
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "false");
  await expect(toggle(page, PLAN)).toHaveAttribute("aria-expanded", "true");
  await toggle(page, QUESTION).click();
  await page.reload();
  await settle(page);
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "true");
  await ctx.close();
  // Without storage the card still folds, until the page reloads.
  const bare = await browser.newContext();
  await bare.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("storage is off");
      },
    });
  });
  const p = await bare.newPage();
  await p.goto("/");
  await settle(p);
  await toggle(p, QUESTION).click();
  await expect(toggle(p, QUESTION)).toHaveAttribute("aria-expanded", "false");
  await p.reload();
  await settle(p);
  await expect(toggle(p, QUESTION)).toHaveAttribute("aria-expanded", "true");
  await bare.close();
});

test("ui: a changed ask opens a folded card again", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const change = await changeable(page);
  await page.goto("/");
  await settle(page);
  await toggle(page, QUESTION).click();
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "false");
  change.suffix = " (round 2)";
  await page.reload();
  await settle(page);
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "true");
  // The old fold is forgotten, not kept for when the ask changes back.
  change.suffix = "";
  await page.reload();
  await settle(page);
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "true");
  await ctx.close();
});

test("ui: live updates keep a card folded", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const change = await changeable(page);
  await page.goto("/");
  await settle(page);
  const order = () =>
    page.locator(".needs-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-intent")));
  const before = await order();
  await toggle(page, QUESTION).click();
  // An update with nothing changed: the card stays folded, in place.
  await refetch(page);
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "false");
  expect(await order()).toEqual(before);
  // An update that changes the ask opens it.
  change.suffix = " (round 2)";
  await refetch(page);
  await expect(toggle(page, QUESTION)).toHaveAttribute("aria-expanded", "true");
  await ctx.close();
});
