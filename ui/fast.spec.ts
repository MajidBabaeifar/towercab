// FAST-10: the page shows the fast lane label and progress, the next fast intent, and sets the mark.

import { expect, test } from "@playwright/test";
import { IDS, serveFixture } from "./fixture.ts";

test.use({ viewport: { width: 360, height: 800 } });

async function open(o: { fast?: boolean } = { fast: true }) {
  const { fixture, server } = await serveFixture(0, o);
  return { fixture, server, base: `http://localhost:${server.port()}` };
}

test("ui: a fast lane card shows the label and progress", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(base);
    const row = page.getByRole("option", { name: /Rewrite the getting-started guide/ });
    await expect(row.locator(".fast-badge")).toHaveText("Fast lane · review, 5 of 6");
    await page.goto(`${base}/i/${IDS.ci}`);
    await expect(page.locator(".fast-badge").first()).toHaveText("Fast lane · checks, 4 of 6");
    await expect(page.getByText("Answered automatically: Where does the button go?")).toContainText("Right");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator(".fast-badge").first()).toBeVisible();
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: the next fast intent is labelled", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(`${base}/board`);
    const card = page.locator(".board-card", { hasText: "Dark mode for the settings page" });
    await expect(card.locator(".fast-badge").first()).toHaveText("next in the fast lane");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: the owner sets the fast lane from the page", async ({ page }) => {
  const { fixture, server, base } = await open({});
  try {
    await page.goto(`${base}/i/${IDS.building}`);
    await page.getByRole("button", { name: "Put in the fast lane" }).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "fast").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "fast", intent: IDS.building, fast: true });
    await page.getByRole("button", { name: "Take out" }).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "fast").length).toBe(2);
    expect(fixture.calls.at(-1)).toEqual({ action: "fast", intent: IDS.building, fast: false });
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
