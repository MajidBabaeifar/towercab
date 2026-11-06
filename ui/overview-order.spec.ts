// UI-246 to UI-248, UI-251: the overview puts what waits on the owner first, proposals take one line each,
// and a card shows its ask, brief and main button before the detail.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));
const PHONE = { width: 375, height: 812 };

async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

/** The crowded fixture served on its own port. */
async function crowded() {
  const { fixture, server } = await serveFixture(0, { crowded: true });
  return { fixture, server, base: `http://localhost:${server.port()}` };
}

const top = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())?.y ?? Number.NaN;

test("ui: fixture overview has the first needs-you card above the proposals", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server, base } = await crowded();
  try {
    for (const m of [
      { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
      { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
      { mode: "mobile", scheme: "light", viewport: PHONE },
    ] as const) {
      const ctx = await browser.newContext({ colorScheme: m.scheme, viewport: m.viewport });
      const page = await ctx.newPage();
      await page.goto(`${base}/`);
      await settle(page);
      expect(await top(page, ".needs-card")).toBeLessThan(await top(page, "#proposed"));
      await expect(page.locator(".needs-card", { hasText: "Send invoice emails" })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `overview ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `overview-crowded-${m.mode}.png`), fullPage: true });
      await ctx.close();
    }
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: overview puts needs-you cards before proposals", async ({ browser }) => {
  const { fixture, server, base } = await crowded();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await settle(page);
    const y = {
      hero: await top(page, ".hero"),
      needs: await top(page, ".needs-card"),
      problems: await top(page, "#problems"),
      proposed: await top(page, "#proposed"),
    };
    const working = await page.locator("section", { has: page.getByRole("heading", { name: /^Working/ }) });
    const workingY = (await working.first().boundingBox())?.y ?? Number.NaN;
    expect(y.hero).toBeLessThan(y.needs);
    expect(y.needs).toBeLessThan(y.problems);
    expect(y.problems).toBeLessThan(y.proposed);
    expect(y.proposed).toBeLessThan(workingY);
    // One number: the headline and the top bar agree, and the parts add up.
    const n = Number(/^(\d+) things? need/.exec((await page.locator("h1").first().textContent()) ?? "")?.[1]);
    const proposed = await page.locator(".proposed-row, .proposed-card").count();
    expect(n).toBeGreaterThan(proposed);
    await expect(page.locator("h1").first()).toContainText("proposed");
    await ctx.close();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: the airspace starts folded on a phone", async ({ browser }) => {
  const { fixture, server, base } = await crowded();
  try {
    const phone = await browser.newContext({ viewport: PHONE });
    const p = await phone.newPage();
    await p.goto(`${base}/`);
    await settle(p);
    await expect(p.getByRole("button", { name: "Show airspace" })).toBeVisible();
    await p.getByRole("button", { name: "Show airspace" }).click();
    await expect(p.getByRole("button", { name: "Hide airspace" })).toBeVisible();
    await phone.close();
    const wide = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const w = await wide.newPage();
    await w.goto(`${base}/`);
    await settle(w);
    await expect(w.getByRole("button", { name: "Hide airspace" })).toBeVisible();
    await wide.close();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: proposed intents are one line each", async ({ browser }) => {
  const { fixture, server, base } = await crowded();
  try {
    const ctx = await browser.newContext({ viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await settle(page);
    const rows = page.locator("#proposed .proposed-row");
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let k = 0; k < n; k++) {
      const box = (await rows.nth(k).boundingBox())!;
      expect(box.height, `row ${k}`).toBeLessThan(90);
      await expect(rows.nth(k).getByRole("button", { name: "Accept" })).toBeVisible();
      await expect(rows.nth(k).getByRole("button", { name: "Close" })).toBeVisible();
    }
    // The title opens the intent file; the PR is a link too.
    const first = rows.first();
    await expect(first.locator("a.proposed-title")).toHaveAttribute("href", /\/blob\//);
    await expect(first.locator("a.proposed-gh")).toHaveAttribute("href", /\/pull\/\d+$/);
    await ctx.close();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: proposals after the fifth fold under a button", async ({ browser }) => {
  const { fixture, server, base } = await crowded();
  try {
    const ctx = await browser.newContext({ viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await settle(page);
    const total = fixture.state.proposed.list.length;
    expect(total).toBeGreaterThan(5);
    await expect(page.locator("#proposed .proposed-row")).toHaveCount(5);
    const more = page.getByRole("button", { name: `Show ${total - 5} more proposals` });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await more.click();
    await expect(page.locator("#proposed .proposed-row")).toHaveCount(total);
    await expect(page.getByRole("button", { name: "Show fewer proposals" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await ctx.close();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: the main button sits under the brief", async ({ browser }) => {
  const { fixture, server, base } = await crowded();
  try {
    const ctx = await browser.newContext({ viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await settle(page);
    // The plan card has a brief and a merge button; the button comes right after the brief, before the access list.
    const card = page.locator('.needs-card[data-intent="261025-0910-1"]');
    const brief = (await card.locator(".brief").boundingBox())!;
    const merge = (await card.getByRole("button", { name: "Merge plan PR" }).boundingBox())!;
    const access = (await card.locator(".access").first().boundingBox())!;
    expect(merge.y).toBeGreaterThan(brief.y);
    expect(merge.y).toBeLessThan(access.y);
    // And within the first screen's worth of the card.
    const cardTop = (await card.boundingBox())!.y;
    expect(merge.y + merge.height - cardTop).toBeLessThan(700);
    await ctx.close();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: risk and open points are folded to one line each", async ({ browser }) => {
  const { fixture, server, base } = await crowded();
  try {
    const ctx = await browser.newContext({ viewport: PHONE });
    const page = await ctx.newPage();
    await page.goto(`${base}/`);
    await settle(page);
    const code = page.locator('.needs-card[data-intent="261024-1130-1"]');
    const fold = code.locator("details.risk-fold");
    await expect(fold.locator("summary")).toHaveText(/risk · (easy|hard) to undo · .*sure it works$/);
    await expect(fold).not.toHaveAttribute("open", "");
    await expect(fold.locator(".risk-head")).toBeHidden();
    await fold.locator("summary").click();
    await expect(fold.locator(".risk-head")).toBeVisible();
    // The spec card: three open points fold to one line, each opening on tap, below the merge button.
    const spec = page.locator('.needs-card[data-intent="261026-1340-1"]');
    const points = spec.locator("details.points-fold");
    await expect(points.locator("summary").first()).toHaveText("3 open points for you");
    await expect(points.locator("li details")).toHaveCount(3);
    await expect(points.locator("li .access-why").first()).toBeHidden();
    await points.locator("summary").first().click();
    await points.locator("li details summary").first().click();
    await expect(points.locator("li .access-why").first()).toBeVisible();
    const merge = (await spec.getByRole("button", { name: "Merge spec PR" }).boundingBox())?.y;
    const folded = (await points.boundingBox())?.y;
    if (merge !== undefined && folded !== undefined) expect(merge).toBeLessThan(folded);
    await ctx.close();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
