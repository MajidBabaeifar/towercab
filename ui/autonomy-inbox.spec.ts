// UI-257, UI-258 on the inbox (the home page): the control on a selected card, and the card for a raise
// somebody else made.

import { expect, test } from "@playwright/test";
import { IDS, serveFixture } from "./fixture.ts";

async function open(o: { flagged?: boolean } = {}) {
  const { fixture, server } = await serveFixture(0, o);
  if (!o.flagged) fixture.store.open.find((i) => i.id === IDS.plan)!.a = 3;
  return { fixture, server, base: `http://localhost:${server.port()}` };
}

const seg = (scope: ReturnType<import("@playwright/test").Page["locator"]>, n: number) =>
  scope.locator("button.seg", { hasText: new RegExp(`^a${n}`) });

test("ui: the inbox card changes autonomy", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(base);
    const control = page.locator(".inbox-detail .autonomy").first();
    await expect(seg(control, 3)).toHaveAttribute("aria-pressed", "true");
    await seg(control, 2).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "autonomy").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "autonomy", intent: IDS.plan, a: 2 });
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: the inbox shows a flagged raise and accepts or sets it back", async ({ page }) => {
  const { fixture, server, base } = await open({ flagged: true });
  try {
    await page.goto(base);
    // One inbox item per intent: the flag shows inside the plan's own card.
    const detail = page.locator(".inbox-detail");
    await expect(detail).toContainText("mallory raised it to a5. It still runs at a2 until you decide.");
    await detail.getByRole("button", { name: "Accept a5" }).click();
    await expect(detail.getByRole("alertdialog")).toContainText("Raise to a5?");
    expect(fixture.calls.filter((c) => c.action === "autonomy")).toEqual([]);
    await detail.getByRole("button", { name: "Cancel" }).click();
    await detail.getByRole("button", { name: "Set back to a2" }).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "autonomy").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "autonomy", intent: IDS.plan, a: 2 });
    await expect(detail).not.toContainText("mallory raised");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
