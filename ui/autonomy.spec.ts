// UI-257, UI-258: the autonomy control on the intent page and on a card, the confirm step of a raise,
// and the card for a raise somebody else made.

import { expect, test } from "@playwright/test";
import { IDS, serveFixture } from "./fixture.ts";

async function open(o: { flagged?: boolean } = {}) {
  const { fixture, server } = await serveFixture(0, o);
  const plan = fixture.store.open.find((i) => i.id === IDS.plan)!;
  if (!o.flagged) plan.a = 3;
  return { fixture, server, base: `http://localhost:${server.port()}` };
}

const seg = (scope: ReturnType<import("@playwright/test").Page["locator"]>, n: number) =>
  scope.locator("button.seg", { hasText: new RegExp(`^a${n}`) });

test("ui: the intent page changes autonomy", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(`${base}/i/${IDS.plan}`);
    const control = page.locator("main.intent .autonomy").first();
    await expect(seg(control, 3)).toHaveAttribute("aria-pressed", "true");
    await expect(seg(control, 3)).toContainText("(current)");
    await seg(control, 1).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved. Applies from the next gate." }),
    ).toBeVisible();
    expect(fixture.calls.filter((c) => c.action === "autonomy")).toEqual([
      { action: "autonomy", intent: IDS.plan, a: 1 },
    ]);
    await expect(seg(page.locator("main.intent .autonomy").first(), 1)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: a card changes autonomy", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(base);
    const card = page.locator(".needs-card", { has: page.locator(`a[href="/i/${IDS.plan}"]`) });
    await expect(seg(card.locator(".autonomy"), 3)).toHaveAttribute("aria-pressed", "true");
    await seg(card.locator(".autonomy"), 2).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "autonomy").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "autonomy", intent: IDS.plan, a: 2 });
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: raising autonomy asks for a confirmation that names the level", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(`${base}/i/${IDS.plan}`);
    const control = page.locator("main.intent .autonomy").first();
    await seg(control, 4).click();
    const dialog = control.getByRole("alertdialog");
    await expect(dialog).toContainText("Raise to a4?");
    await expect(dialog).toContainText("merges the change itself");
    // Nothing is written until the owner confirms.
    expect(fixture.calls.filter((c) => c.action === "autonomy")).toEqual([]);
    await dialog.getByRole("button", { name: "Raise" }).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "autonomy").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "autonomy", intent: IDS.plan, a: 4 });
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: lowering autonomy is one click", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(`${base}/i/${IDS.plan}`);
    const control = page.locator("main.intent .autonomy").first();
    await seg(control, 0).click();
    await expect(control.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(() => fixture.calls.filter((c) => c.action === "autonomy").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "autonomy", intent: IDS.plan, a: 0 });
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: cancelling the confirmation writes nothing", async ({ page }) => {
  const { fixture, server, base } = await open();
  try {
    await page.goto(`${base}/i/${IDS.plan}`);
    const control = page.locator("main.intent .autonomy").first();
    await seg(control, 5).click();
    await control.getByRole("button", { name: "Cancel" }).click();
    await expect(control.getByRole("alertdialog")).toHaveCount(0);
    await seg(control, 5).click();
    await page.keyboard.press("Escape");
    await expect(control.getByRole("alertdialog")).toHaveCount(0);
    expect(fixture.calls.filter((c) => c.action === "autonomy")).toEqual([]);
    await expect(seg(control, 3)).toHaveAttribute("aria-pressed", "true");
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: accepting a flagged raise asks for a confirmation", async ({ page }) => {
  const { fixture, server, base } = await open({ flagged: true });
  try {
    await page.goto(base);
    const card = page.locator(".needs-card.kind-autonomy");
    await expect(card).toContainText("It still runs at a2 until you decide.");
    await card.getByRole("button", { name: "Accept a5" }).click();
    await expect(card.getByRole("alertdialog")).toContainText("Raise to a5?");
    expect(fixture.calls.filter((c) => c.action === "autonomy")).toEqual([]);
    await card.getByRole("alertdialog").getByRole("button", { name: "Raise" }).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "autonomy").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "autonomy", intent: IDS.plan, a: 5 });
    await expect(page.locator(".needs-card.kind-autonomy")).toHaveCount(0);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: setting a flagged raise back removes the card", async ({ page }) => {
  const { fixture, server, base } = await open({ flagged: true });
  try {
    await page.goto(base);
    const card = page.locator(".needs-card.kind-autonomy");
    await card.getByRole("button", { name: "Set back to a2" }).click();
    await expect.poll(() => fixture.calls.filter((c) => c.action === "autonomy").length).toBe(1);
    expect(fixture.calls.at(-1)).toEqual({ action: "autonomy", intent: IDS.plan, a: 2 });
    await expect(page.locator(".needs-card.kind-autonomy")).toHaveCount(0);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});
