// UI-164: the exit buttons of a wait, the confirm before one closes an open PR with commits, and the stuck
// cards, in light, dark and on a phone, saved for review with their key content checked.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { IDS, serveFixture } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

const MODES = [
  { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
  { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
  { mode: "mobile", scheme: "light", viewport: { width: 375, height: 812 } },
] as const;

test("ui: exits screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { exits: true });
  try {
    for (const m of MODES) {
      const ctx = await browser.newContext({
        colorScheme: m.scheme,
        viewport: m.viewport,
        deviceScaleFactor: m.mode === "mobile" ? 2 : 1,
        isMobile: m.mode === "mobile",
        hasTouch: m.mode === "mobile",
      });
      const page = await ctx.newPage();
      // UI-266: the cards are items of the Inbox, one at a time: every item is looked at in turn.
      const base = `http://localhost:${server.port()}`;
      const items: { key: string }[] = (await (await fetch(`${base}/api/inbox`)).json()).items;
      let text = "";
      for (const item of items) {
        await page.goto(`${base}/inbox/${item.key}`);
        await page.waitForSelector(".inbox-row", { state: "attached" });
        await page.waitForLoadState("networkidle");
        text += `\n${await page.locator("body").textContent()}`;
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${item.key} ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
        const exits = page.locator(".needs-card:not(.stuck-card) .exits");
        if (await exits.count()) {
          await page.screenshot({ path: join(SHOTS, `exits-overview-${m.mode}.png`), fullPage: true });
          // LOOP-76: the card holding an open PR with 3 commits asks before it closes it.
          const done = page.getByRole("button", { name: "Nothing to build: I did it myself" });
          if (item.key === IDS.plan) {
            await done.click();
            const dialog = page.getByRole("dialog", { name: "Confirm" });
            await expect(dialog).toContainText("PR #12 (3 commits)");
            await expect(dialog).toContainText("Nothing is merged");
            await page.screenshot({ path: join(SHOTS, `exits-confirm-${m.mode}.png`), fullPage: true });
            await dialog.getByRole("button", { name: "Cancel" }).click();
            await expect(dialog).toBeHidden();
          }
        }
      }
      for (const want of [
        "Nothing to build: I did it myself",
        "Towercab recommends",
        "Gives you the steps",
        "Drops the intent",
      ])
        expect(text).toContain(want);
      await ctx.close();
    }
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: a stuck card screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { exits: true });
  try {
    for (const m of MODES) {
      const ctx = await browser.newContext({
        colorScheme: m.scheme,
        viewport: m.viewport,
        deviceScaleFactor: m.mode === "mobile" ? 2 : 1,
        isMobile: m.mode === "mobile",
        hasTouch: m.mode === "mobile",
      });
      const page = await ctx.newPage();
      const base = `http://localhost:${server.port()}`;
      const items: { key: string }[] = (await (await fetch(`${base}/api/inbox`)).json()).items;
      // The stuck wait that offers every change of course, and the one that offers only start over and drop.
      const seen: string[] = [];
      for (const item of items) {
        await page.goto(`${base}/inbox/${item.key}`);
        await page.waitForSelector(".inbox-row", { state: "attached" });
        await page.waitForLoadState("networkidle");
        const card = page.locator(".needs-card.stuck-card");
        if (!(await card.count())) continue;
        await expect(card).toContainText("Stuck: this came back with nothing new");
        // A stuck wait has no reply box.
        await expect(card.getByRole("button", { name: "Send reply" })).toHaveCount(0);
        const full =
          (await card.getByRole("button", { name: "Nothing to build: I did it myself" }).count()) > 0;
        seen.push(full ? "full" : "short");
        await page.screenshot({
          path: join(SHOTS, `exits-stuck-${full ? "full" : "short"}-${m.mode}.png`),
          fullPage: true,
        });
      }
      expect(seen.sort()).toEqual(["full", "short"]);
      await ctx.close();
    }
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
