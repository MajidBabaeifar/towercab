// UI-265: Cmd-K finds intents, repos and PRs and runs commands.

import { expect, test } from "@playwright/test";
import { inboxFixture, settle } from "./inbox-helpers.ts";

const dialogName = "Search and commands";
const dlg = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: dialogName });

test("ui: cmd-k opens and closes by keyboard", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/overview`);
    await page.waitForSelector(".page");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: dialogName });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.keyboard.press("Meta+k");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Meta+k");
    await expect(dialog).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: cmd-k finds an intent, a repo and a PR number", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.keyboard.press("Control+k");
    const box = page.getByRole("combobox");
    await box.fill("rate-limit");
    await expect(dlg(page).getByRole("option", { name: /Rate-limit the public API/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/i\/261025-0910-1$/);
    // A repo by name.
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("docs");
    await expect(dlg(page).getByRole("option", { name: "docs", exact: true })).toBeVisible();
    // A PR, by number or with a hash.
    await page.getByRole("combobox").fill("#201");
    await expect(dlg(page).getByRole("option", { name: /#201 Export invoices/ })).toBeVisible();
    await page.getByRole("combobox").fill("203");
    await expect(dlg(page).getByRole("option", { name: /#203/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${f.base}/inbox/proposed-203`);
  } finally {
    await f.stop();
  }
});

test("ui: cmd-k runs go to repo", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("go to repo api");
    await expect(dlg(page).getByRole("option", { name: /go to repo api/ })).toBeVisible();
    await page.keyboard.press("ArrowDown").catch(() => {});
    await dlg(page)
      .getByRole("option", { name: /go to repo api/ })
      .click();
    await expect(page).toHaveURL(`${f.base}/repos?repo=api`);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("go to board");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${f.base}/board`);
  } finally {
    await f.stop();
  }
});

test("ui: cmd-k pause asks for the usual confirm", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("pause");
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("dialog", { name: "Confirm" });
    await expect(confirm).toContainText("Pause?");
    expect(f.fixture.calls).toEqual([]);
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect(f.fixture.calls).toEqual([]);
    // Cancel goes back to the search box.
    await page.getByRole("combobox").fill("pause");
    await page.keyboard.press("Enter");
    await page
      .getByRole("dialog", { name: "Confirm" })
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await expect.poll(() => f.fixture.calls).toEqual([{ action: "pause" }]);
  } finally {
    await f.stop();
  }
});

test("ui: cmd-k offers only applicable commands", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("resume");
    await expect(dlg(page).getByRole("option", { name: "resume" })).toHaveCount(0);
    await page.getByRole("combobox").fill("pause");
    await expect(dlg(page).getByRole("option", { name: "pause", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    // Paused: resume is offered and pause is not.
    f.fixture.state.paused = true;
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("resume");
    await expect(dlg(page).getByRole("option", { name: "resume", exact: true })).toBeVisible();
    await page.getByRole("combobox").fill("pause");
    await expect(dlg(page).getByRole("option", { name: "pause", exact: true })).toHaveCount(0);
  } finally {
    await f.stop();
  }
});
