// UI-268..275: the not-ready badge, the setup section, the Board's columns, the stage map and the phone
// top bar, measured in the browser against the fixture with ten repos (several not ready).

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));
const CLI_INTENT = "261026-0930-1";

async function open(browser: Browser, width: number, height: number) {
  const { fixture, server } = await serveFixture(0, { readiness: true, many: true });
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const go = async (path: string) => {
    await page.goto(`http://localhost:${server.port()}${path}`);
    await page.waitForSelector(".page");
    await page.waitForLoadState("networkidle");
  };
  const stop = async () => {
    await ctx.close();
    await server.stop();
    fixture.cleanup();
  };
  return { page, go, stop };
}

const box = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });

test("ui: the not-ready badge fits its text", async ({ browser }) => {
  const t = await open(browser, 1280, 900);
  try {
    await t.go("/repos");
    const badges = t.page.locator(".repo-card .ready-badge");
    expect(await badges.count()).toBeGreaterThan(0);
    for (const b of await badges.all()) {
      const w = await b.evaluate((el) => ({
        badge: el.getBoundingClientRect().width,
        card: el.closest(".repo-card")!.getBoundingClientRect().width,
        text: el.scrollWidth,
      }));
      expect(w.badge).toBeLessThan(w.card * 0.6);
      expect(w.badge).toBeLessThanOrEqual(w.text + 24);
    }
  } finally {
    await t.stop();
  }
});

test("ui: setup section has card padding", async ({ browser }) => {
  const t = await open(browser, 1280, 900);
  try {
    await t.go("/repos?repo=web");
    const pad = await t.page.locator(".repo-setup").evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(Number.parseFloat);
    });
    for (const p of pad) expect(p).toBeGreaterThanOrEqual(16);
    // The raw command error is folded under "Details" and not in view.
    await t.go("/repos?repo=ops");
    await expect(t.page.locator(".repo-setup")).toContainText("give it the Actions permission");
    await expect(t.page.locator(".repo-setup .setup-raw code")).toBeHidden();
    await t.page.locator(".repo-setup .setup-raw summary").first().click();
    await expect(t.page.locator(".repo-setup .setup-raw code").first()).toContainText("HTTP 403");
  } finally {
    await t.stop();
  }
});

test("ui: empty board stations collapse to a strip", async ({ browser }) => {
  const t = await open(browser, 1280, 900);
  try {
    await t.go("/board");
    const heads = t.page.locator(".board-col-head");
    const widths = await heads.evaluateAll((els) =>
      els.map((el) => ({
        empty: el.classList.contains("narrow"),
        width: el.getBoundingClientRect().width,
      })),
    );
    expect(widths.some((w) => w.empty)).toBe(true);
    for (const w of widths.filter((x) => x.empty)) expect(w.width).toBeLessThanOrEqual(60);
  } finally {
    await t.stop();
  }
});

test("ui: busy board stations are at least 180px", async ({ browser }) => {
  const t = await open(browser, 1280, 900);
  try {
    await t.go("/board");
    const widths = await t.page
      .locator(".board-col-head:not(.narrow)")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    expect(widths.length).toBeGreaterThan(0);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(179);
  } finally {
    await t.stop();
  }
});

test("ui: board chips are not clipped at 1280px", async ({ browser }) => {
  const t = await open(browser, 1280, 900);
  try {
    await t.go("/board");
    const clipped = await t.page.locator(".board-card-foot .chip").evaluateAll((els) =>
      els
        .filter((el) => {
          const card = el.closest(".board-card")!.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          return el.scrollWidth > el.clientWidth + 1 || r.right > card.right + 1;
        })
        .map((el) => el.textContent),
    );
    expect(clipped).toEqual([]);
  } finally {
    await t.stop();
  }
});

test("ui: board titles cut after three lines with the full title on hover", async ({ browser }) => {
  const t = await open(browser, 1280, 900);
  try {
    await t.go("/board");
    const title = t.page.locator(".board-card-title").first();
    const info = await title.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        clamp: s.getPropertyValue("-webkit-line-clamp"),
        lines: Math.round(el.getBoundingClientRect().height / Number.parseFloat(s.lineHeight)),
        title: el.getAttribute("title"),
        text: el.textContent,
      };
    });
    expect(info.clamp).toBe("3");
    expect(info.lines).toBeLessThanOrEqual(3);
    expect(info.title).toBe(info.text);
  } finally {
    await t.stop();
  }
});

test("ui: board is as wide as the top bar", async ({ browser }) => {
  const t = await open(browser, 1400, 900);
  try {
    await t.go("/board");
    const bar = await box(t.page, ".topbar-inner");
    const board = await box(t.page, ".board");
    // The top bar pads its content; the board lines up with the content of the page, which is no wider.
    expect(board.width).toBeLessThanOrEqual(bar.width + 1);
    expect(board.right).toBeLessThanOrEqual(bar.right + 1);
  } finally {
    await t.stop();
  }
});

test("ui: phone top bar is at most 100px", async ({ browser }) => {
  const t = await open(browser, 375, 812);
  try {
    await t.go("/board");
    expect((await box(t.page, ".topbar")).height).toBeLessThanOrEqual(100);
    // "Updated" is on the counts line, not on a line of its own.
    await expect(t.page.locator(".counts .fresh")).toBeVisible();
    await expect(t.page.locator(".tabs-inner .fresh")).toBeHidden();
  } finally {
    await t.stop();
  }
});

test("ui: phone airspace starts folded", async ({ browser }) => {
  const t = await open(browser, 375, 812);
  try {
    await t.go("/overview");
    await expect(t.page.locator(".air-collapsed")).toBeVisible();
    await expect(t.page.locator("svg.air-svg")).toHaveCount(0);
  } finally {
    await t.stop();
  }
});

test("ui: airspace count badges do not overlap at 360, 768 and 1280px", async ({ browser }) => {
  for (const width of [360, 768, 1280]) {
    const t = await open(browser, width, 900);
    try {
      await t.go("/overview");
      // A phone starts folded: open it to look at the map.
      const toggle = t.page.getByRole("button", { name: "Show airspace" });
      if (await toggle.count()) await toggle.click();
      await t.page.waitForSelector("svg.air-svg");
      const hits = await t.page.evaluate(() => {
        const rect = (el: Element) => el.getBoundingClientRect();
        const badges = [...document.querySelectorAll(".air-more")].map(rect);
        const others = [...document.querySelectorAll("svg.air-svg .air-label:not(.air-more-text), .air-hit")]
          .filter((el) => !el.closest("g")?.querySelector(".air-more"))
          .map((el) => ({ el, r: rect(el) }));
        const hit: string[] = [];
        for (const b of badges)
          for (const o of others)
            if (b.left < o.r.right && o.r.left < b.right && b.top < o.r.bottom && o.r.top < b.bottom)
              hit.push(o.el.textContent || o.el.getAttribute("class") || "?");
        return { badges: badges.length, hit };
      });
      expect(hits.hit, `badges overlap at ${width}px`).toEqual([]);
    } finally {
      await t.stop();
    }
  }
});

test("ui: clarity screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { readiness: true, many: true });
  try {
    const modes = [
      { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
      { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
      { mode: "mobile", scheme: "light", viewport: { width: 375, height: 812 } },
    ] as const;
    const pages = [
      { name: "clarity-repos", path: "/repos", expect: "repos have no release job" },
      { name: "clarity-board", path: "/board", expect: "repos: no release job" },
      { name: "clarity-cli-intent", path: `/i/${CLI_INTENT}`, expect: "Not part of this repo's path" },
      { name: "clarity-overview", path: "/overview", expect: "Airspace" },
    ] as const;
    for (const m of modes) {
      const ctx = await browser.newContext({
        colorScheme: m.scheme,
        viewport: m.viewport,
        deviceScaleFactor: m.mode === "mobile" ? 2 : 1,
        isMobile: m.mode === "mobile",
        hasTouch: m.mode === "mobile",
      });
      const page = await ctx.newPage();
      for (const p of pages) {
        await page.goto(`http://localhost:${server.port()}${p.path}`);
        await page.waitForSelector(".page");
        await page.waitForLoadState("networkidle");
        await expect(page.locator("body")).toContainText(p.expect);
        await page.screenshot({ path: join(SHOTS, `${p.name}-${m.mode}.png`), fullPage: true });
      }
      await ctx.close();
    }
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: stage map folds unreached stages and sums up the rest", async ({ browser }) => {
  const t = await open(browser, 375, 812);
  try {
    await t.go(`/i/${CLI_INTENT}`);
    await expect(t.page.locator(".smap-off")).toContainText("Not part of this repo's path");
    await expect(t.page.locator(".smap-off")).toContainText("deploying");
    await t.go("/i/261025-0910-1");
    await expect(t.page.locator(".smap-more summary").first()).toContainText("more stages to go");
  } finally {
    await t.stop();
  }
});
