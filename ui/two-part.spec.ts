// UI-281: a card shows the people part and a link; the agent part is folded on the intent page.

import { expect, test } from "@playwright/test";
import { IDS } from "./fixture.ts";
import { inboxFixture, settle } from "./inbox-helpers.ts";

test("ui: the agent context is a link on a card and folded on the intent page", async ({ page }) => {
  const f = await inboxFixture({});
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page.locator(".agent-link").first()).toHaveText("Agent context");
    await expect(page.locator(".card .details-fold")).toHaveCount(0);
    await page.goto(`${f.base}/i/${IDS.code}`);
    await page.waitForSelector(".details-fold");
    await expect(page.locator(".details-fold summary").first()).toHaveText("Agent context");
    await expect(page.locator(".details-fold").first()).not.toHaveAttribute("open", "");
  } finally {
    await f.stop();
  }
});
