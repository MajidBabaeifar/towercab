// UI-165..167: the parts list and the freeze on the intent page, the Board's repo count and frozen lane,
// and the freeze buttons, in light, dark and on a phone, saved for review with their key content checked.

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

test("ui: parts screenshots light, dark and mobile", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { fixture, server } = await serveFixture(0, { parts: true });
  try {
    const base = `http://localhost:${server.port()}`;
    for (const m of MODES) {
      const ctx = await browser.newContext({
        colorScheme: m.scheme,
        viewport: m.viewport,
        deviceScaleFactor: m.mode === "mobile" ? 2 : 1,
        isMobile: m.mode === "mobile",
        hasTouch: m.mode === "mobile",
      });
      const page = await ctx.newPage();
      const look = async (path: string, name: string, wanted: string[]) => {
        await page.goto(`${base}${path}`);
        await page.waitForLoadState("networkidle");
        const text = (await page.locator("body").textContent()) ?? "";
        for (const w of wanted) expect(text, `${name} ${m.mode}`).toContain(w);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${name} ${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: join(SHOTS, `${name}-${m.mode}.png`), fullPage: true });
      };
      await look(`/i/${IDS.ci}`, "parts-intent", [
        "Parts",
        "infra",
        "web",
        "Merges frozen in infra, web for 1 h",
        "waiting for the part it merges after (infra)",
      ]);
      await look("/board", "parts-board", [
        "Merges frozen for Faster checkout page",
        "2 repos",
        "waiting for the freeze",
      ]);
      await look(`/i/${IDS.code}`, "parts-freeze", ["Keep waiting", "Unfreeze"]);
      await ctx.close();
    }
    // Unfreeze asks first when a part is already merged, then posts the action.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const asked: string[] = [];
    page.on("dialog", (d) => {
      asked.push(d.message());
      void d.accept();
    });
    await page.goto(`${base}/i/${IDS.code}`);
    await page.getByRole("button", { name: "Unfreeze" }).click();
    await expect
      .poll(() => fixture.calls.some((c) => c.action === "unfreeze" && c.intent === IDS.code))
      .toBe(true);
    expect(asked).toEqual(["A part is already merged: the intent will end as merged, not verified live."]);
    await ctx.close();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
