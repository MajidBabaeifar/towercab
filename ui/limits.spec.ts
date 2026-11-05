// UI-150..154: the Settings section of a repo's page, in a real browser: the confirm line in the first
// day, what a save sends, a failed save, and the form on a phone and by keyboard.

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { PARSER_KEY } from "../src/repo/settings.ts";
import { startUi } from "../src/ui/server.ts";
import { buildFixture } from "./fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(here, "screenshots"));

interface Sent {
  changes: unknown;
  confirmed: boolean;
}

async function serve(o: { aged?: boolean; fail?: string } = {}) {
  const fixture = buildFixture();
  if (o.aged) fixture.db.setMeta(PARSER_KEY, `abc ${Math.floor(Date.now() / 1000) - 25 * 3600}`);
  const sent: Sent[] = [];
  const server = startUi({
    port: 0,
    sources: fixture.sources,
    actions: {
      ...fixture.actions,
      repoSettings: async (_repo, changes, confirmed) => {
        sent.push({ changes, confirmed });
        if (o.fail) throw new Error(o.fail);
        return "Opened PR #12. The change applies after it is merged.";
      },
      repoMove: async () => "Opened PR #13.",
    },
    distDir: resolve(here, "dist"),
    log: () => {},
    pollMs: 500,
  });
  await server.ready;
  const stop = async () => {
    await server.stop();
    fixture.cleanup();
  };
  return { fixture, sent, url: `http://localhost:${server.port()}/repos?repo=web`, stop };
}

const CONFIRM =
  "An older Towercab can't read this setting; a rollback in the next day would need a manual fix.";

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForSelector(".repo-limits");
  await page.waitForLoadState("networkidle");
}

test("ui: a save in the first 24 hours asks to confirm", async ({ page }) => {
  const s = await serve();
  try {
    await open(page, s.url);
    await page.getByLabel("Missions building at once").fill("4");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(CONFIRM)).toBeVisible();
    expect(s.sent).toEqual([]);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText(CONFIRM)).toBeHidden();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Save anyway" }).click();
    await expect(page.getByText("Opened PR #12. The change applies after it is merged.")).toBeVisible();
    expect(s.sent).toEqual([{ changes: { workers: 4 }, confirmed: true }]);
  } finally {
    await s.stop();
  }
});

test("ui: no confirm line after the wait", async ({ page }) => {
  const s = await serve({ aged: true });
  try {
    await open(page, s.url);
    await page.getByLabel("Intents ahead of build").fill("5");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Opened PR #12.")).toBeVisible();
    await expect(page.getByText(CONFIRM)).toBeHidden();
    expect(s.sent).toEqual([{ changes: { ahead: 5 }, confirmed: false }]);
  } finally {
    await s.stop();
  }
});

test("ui: saving settings posts only the changed keys", async ({ page }) => {
  const s = await serve({ aged: true });
  try {
    s.fixture.db.setMeta("repo-file:web", JSON.stringify({ workers: 3 }));
    await open(page, s.url);
    // Save is off until a value differs from the shown one.
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();
    await page.getByLabel("Intents ahead of build").fill("7");
    await page.getByRole("button", { name: "Back to default" }).click();
    await save.click();
    await expect(page.getByText("Opened PR #12.")).toBeVisible();
    expect(s.sent).toEqual([{ changes: { workers: null, ahead: 7 }, confirmed: false }]);
  } finally {
    await s.stop();
  }
});

test("ui: the form refuses a value outside 1 to 16", async ({ page }) => {
  const s = await serve({ aged: true });
  try {
    await open(page, s.url);
    await page.getByLabel("Missions building at once").fill("20");
    await expect(page.getByText("workers: 20 isn't a whole number from 1 to 16")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    expect(s.sent).toEqual([]);
  } finally {
    await s.stop();
  }
});

test("ui: a failed save keeps what was typed", async ({ page }) => {
  const s = await serve({ aged: true, fail: "GitHub refused to open the pull request: no permission" });
  try {
    await open(page, s.url);
    await page.getByLabel("Missions building at once").fill("4");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("GitHub refused to open the pull request: no permission")).toBeVisible();
    await expect(page.getByLabel("Missions building at once")).toHaveValue("4");
  } finally {
    await s.stop();
  }
});

test("ui: settings fit a phone and work by keyboard", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const s = await serve({ aged: true });
  try {
    s.fixture.db.setMeta(
      "repo-pr:web:move",
      JSON.stringify({ pr: 9, n: 1, changes: { workers: 3 }, state: "closed" }),
    );
    s.fixture.db.setMeta("repo-file-error:web", "workers: 20 isn't a whole number from 1 to 16");
    for (const m of [
      { mode: "light", scheme: "light", viewport: { width: 1280, height: 900 } },
      { mode: "dark", scheme: "dark", viewport: { width: 1280, height: 900 } },
      { mode: "mobile", scheme: "light", viewport: { width: 360, height: 740 } },
    ] as const) {
      const ctx = await browser.newContext({ colorScheme: m.scheme, viewport: m.viewport });
      const page = await ctx.newPage();
      await open(page, s.url);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${m.mode} scrolls sideways`).toBeLessThanOrEqual(0);
      await expect(page.getByText("TOWERCAB.md in web can't be read")).toBeVisible();
      await expect(page.getByRole("button", { name: "Open the move PR again" })).toBeVisible();
      await expect(page.getByText("Kept on this machine only:")).toBeVisible();
      // By keyboard: the label focuses the field, typing changes it, Enter saves.
      const field = page.getByLabel("Missions building at once");
      await field.focus();
      await page.keyboard.press("Control+A");
      await page.keyboard.type("3");
      await page.keyboard.press("Enter");
      await expect(page.getByText("Opened PR #12.")).toBeVisible();
      await page.locator(".repo-limits").screenshot({ path: join(SHOTS, `limits-${m.mode}.png`) });
      await ctx.close();
    }
    expect(s.sent.length).toBe(3);
  } finally {
    await s.stop();
  }
});
