// UI-261, UI-262: the Inbox by keyboard. No key acts without a second step.

import { expect, test } from "@playwright/test";
import { inboxFixture, selectedKey, settle } from "./inbox-helpers.ts";

const PLAN = "261025-0910-1";
const QUESTION = "261026-0815-2";

test("ui: j and k move the inbox selection", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    expect(await selectedKey(page)).toBe("proposed-201");
    await page.keyboard.press("j");
    expect(await selectedKey(page)).toBe(PLAN);
    await expect(page).toHaveURL(`${f.base}/inbox/${PLAN}`);
    await expect(page.locator(".inbox-detail")).toHaveAttribute("data-item", PLAN);
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    expect(await selectedKey(page)).toBe(PLAN);
    // No wrap at either end.
    await page.keyboard.press("k");
    await page.keyboard.press("k");
    expect(await selectedKey(page)).toBe("proposed-201");
    for (let n = 0; n < 12; n++) await page.keyboard.press("j");
    expect(await selectedKey(page)).toBe("proposed-203");
    expect(f.fixture.calls).toEqual([]);
  } finally {
    await f.stop();
  }
});

test("ui: enter opens the card and escape returns to the list", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.keyboard.press("j");
    await expect(page.locator(`#inbox-row-${PLAN}`)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#inbox-detail-title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(`#inbox-row-${PLAN}`)).toBeFocused();
  } finally {
    await f.stop();
  }
});

test("ui: enter only opens and never posts an action", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${PLAN}`);
    await settle(page);
    // With the page's own first selection, with the plan (a merge) selected, on the heading and on the row.
    for (const target of ["body", `#inbox-row-${PLAN}`, "#inbox-detail-title"]) {
      if (target === "body") await page.locator("body").click({ position: { x: 5, y: 400 } });
      else await page.locator(target).focus();
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(300);
    expect(f.fixture.calls).toEqual([]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: m asks before merging and posts nothing until confirmed", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${PLAN}`);
    await settle(page);
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("m");
    const dialog = page.getByRole("dialog", { name: "Merge" });
    await expect(dialog).toContainText(/Merge Plan PR #\d+: Rate-limit the public API\?/);
    expect(f.fixture.calls).toEqual([]);
    // Escape cancels.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(f.fixture.calls).toEqual([]);
    // Merge posts the card's own action.
    await page.keyboard.press("m");
    await dialog.getByRole("button", { name: "Merge", exact: true }).click();
    await expect.poll(() => f.fixture.calls).toEqual([{ action: "merge", intent: PLAN }]);
  } finally {
    await f.stop();
  }
});

test("ui: the merge confirm opens on cancel and needs its own click or enter", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${PLAN}`);
    await settle(page);
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("m");
    const dialog = page.getByRole("dialog", { name: "Merge" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    // Enter on the focused Cancel cancels; the keypress that opened the dialog confirmed nothing.
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    expect(f.fixture.calls).toEqual([]);
    // Tab to Merge, then Enter on it confirms.
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("m");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Merge", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => f.fixture.calls).toEqual([{ action: "merge", intent: PLAN }]);
  } finally {
    await f.stop();
  }
});

test("ui: m does nothing on an item that is not a merge", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${QUESTION}`);
    await settle(page);
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("m");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator('[role="status"]').first()).toContainText("m merges");
    await page.goto(`${f.base}/inbox/proposed-201`);
    await settle(page);
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("m");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(f.fixture.calls).toEqual([]);
  } finally {
    await f.stop();
  }
});

test("ui: r focuses the reply box and o opens the PR", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/inbox/${QUESTION}`);
    await settle(page);
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("r");
    await expect(page.locator(".inbox-detail textarea")).toBeFocused();
    // Typing r in the box is text, not a shortcut.
    await page.keyboard.type("r and o and m");
    await expect(page.locator(".inbox-detail textarea")).toHaveValue("r and o and m");
    await page.goto(`${f.base}/inbox/${PLAN}`);
    await settle(page);
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    const popup = page.waitForEvent("popup");
    await page.keyboard.press("o");
    expect((await popup).url()).toMatch(/\/pull\/\d+/);
    // An item with no PR says so.
    await page.goto(`${f.base}/inbox/${QUESTION}`);
    await settle(page);
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("o");
    await expect(page.locator('[role="status"]').first()).toContainText("no pull request");
  } finally {
    await f.stop();
  }
});

test("ui: shortcuts are ignored while typing", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.getByLabel("Filter the inbox").focus();
    await page.keyboard.type("jkm?so");
    await expect(page.getByLabel("Filter the inbox")).toHaveValue("jkm?so");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("Filter the inbox").fill("");
    expect(await selectedKey(page)).toBe("proposed-201");
    // Combinations with Ctrl or Alt are not shortcuts either.
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("Alt+j");
    expect(await selectedKey(page)).toBe("proposed-201");
    expect(f.fixture.calls).toEqual([]);
  } finally {
    await f.stop();
  }
});

test("ui: the question mark shows the shortcuts", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page.getByRole("button", { name: "? shortcuts" })).toBeVisible();
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    for (const text of ["j / k", "Enter", "m", "r", "o", "?", "Cmd-K"])
      await expect(dialog).toContainText(text);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "? shortcuts" }).click();
    await expect(dialog).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: the shortcuts dialog returns focus", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    const hint = page.getByRole("button", { name: "? shortcuts" });
    await hint.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(hint).toBeFocused();
  } finally {
    await f.stop();
  }
});
