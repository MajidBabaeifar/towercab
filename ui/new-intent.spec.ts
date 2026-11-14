// UI-213..218: the "New intent" form, its overlap step and what happens after Create.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { IDS } from "./fixture.ts";
import { inboxFixture, PHONE, settle } from "./inbox-helpers.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

/** Overlaps "Dark mode for the settings page" (open, not started) and "Rate-limit the public API" (past design). */
const OVERLAPPING = "Towercab shows the public status of each settings change";
/** Overlaps "Sign in with GitHub" (done). */
const DONE_OVERLAP = "Towercab keeps people signed in with github longer";
const UNIQUE = "Xylophone quartz zebra";

const form = (page: Page) => page.getByRole("dialog", { name: "New intent" });

async function openForm(page: Page, base: string, role?: "viewer" | "contributor") {
  if (role) {
    await page.route("**/api/state", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { top: Record<string, unknown> };
      body.top.role = role;
      await route.fulfill({ response: res, json: body });
    });
  }
  await page.goto(`${base}/`);
  await settle(page);
  if (role === "viewer") return;
  await page.getByRole("button", { name: "New intent" }).click();
  await expect(form(page)).toBeVisible();
  await expect(form(page).getByLabel("Repo")).toBeVisible();
  await expect(form(page).locator("#ni-repo option")).not.toHaveCount(1);
}

async function fill(page: Page, title: string, repo = "web") {
  await form(page).getByLabel("Repo").selectOption(repo);
  await form(page).getByLabel("Title").fill(title);
}

test("ui: the new intent form has the template's fields", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    const d = form(page);
    for (const label of [
      "Repo",
      "Title",
      "Problem",
      "Proposed outcome",
      "Affected users and systems",
      "Constraints",
      "Open questions",
    ])
      await expect(d.getByLabel(label, { exact: true })).toBeVisible();
    for (const group of ["Urgency", "Importance", "Autonomy"])
      await expect(d.getByRole("group", { name: group })).toBeVisible();
    // No score is chosen by default.
    await expect(d.locator(".seg.current")).toHaveCount(0);
    await expect(d.getByRole("group", { name: "Autonomy" }).getByRole("button")).toHaveText([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
  } finally {
    await f.stop();
  }
});

test("ui: the form needs only a repo and a title", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    const create = form(page).getByRole("button", { name: "Create", exact: true });
    await expect(create).toBeDisabled();
    await form(page).getByLabel("Repo").selectOption("web");
    await expect(create).toBeDisabled();
    await form(page).getByLabel("Title").fill(UNIQUE);
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page).toHaveURL(/\/i\/261109-\d{4}-1$/);
    const sent = f.fixture.calls.filter((c) => c.action === "createIntent");
    expect(sent).toEqual([{ action: "createIntent", repo: "web", title: UNIQUE }]);
  } finally {
    await f.stop();
  }
});

test("ui: the form shows the naming rule beside the title", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    const hint = form(page).locator("#ni-rule");
    await expect(hint).toContainText(
      "Write it as a user story: the product, then what someone can do or see",
    );
    await expect(hint).toContainText("4 to 20 words");
    await expect(hint).toContainText("Towercab lets the owner write a new intent in a form");
    await expect(form(page).getByLabel("Title")).toHaveAttribute("aria-describedby", "ni-rule");
    // It never changes what is typed.
    await form(page).getByLabel("Title").fill("fix it");
    await expect(form(page).getByLabel("Title")).toHaveValue("fix it");
  } finally {
    await f.stop();
  }
});

test("ui: the new intent button is in the top bar and in search", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page.locator(".topbar").getByRole("button", { name: "New intent" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("new intent");
    await page.getByRole("option", { name: /new intent/i }).click();
    await expect(form(page)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Search and commands" })).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: a viewer has no new intent button", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base, "viewer");
    await expect(page.getByRole("button", { name: "New intent" })).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("new intent");
    await expect(page.getByRole("option", { name: /new intent/i })).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: a contributor's form says a maintainer will review it", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base, "contributor");
    const d = form(page);
    await expect(d).toContainText("A maintainer will accept or close your intent.");
    await expect(d.getByRole("button", { name: "Propose", exact: true })).toBeVisible();
    // Autonomy stops at a4 for a proposal.
    await expect(d.getByRole("group", { name: "Autonomy" }).getByRole("button")).toHaveText([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
    ]);
  } finally {
    await f.stop();
  }
});

test("ui: create shows that the check is running", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/actions", async (route) => {
      if (route.request().postDataJSON().action === "checkIntent") await gate;
      await route.continue();
    });
    await fill(page, OVERLAPPING);
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(form(page).getByText("Checking your intent against the existing ones…")).toBeVisible();
    await expect(form(page).getByLabel("Title")).toBeDisabled();
    await expect(form(page).getByRole("button", { name: "Checking…" })).toBeDisabled();
    release();
    await expect(form(page).getByRole("region", { name: "Possible overlaps" })).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: matches list kind, link and how", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, OVERLAPPING);
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    const list = form(page).getByRole("region", { name: "Possible overlaps" });
    const settings = list.getByRole("listitem").filter({ hasText: "Dark mode for the settings page" });
    await expect(settings).toContainText("Open intent");
    await expect(settings).toContainText("Both are about “settings”");
    await expect(settings.getByRole("link", { name: "Dark mode for the settings page" })).toHaveAttribute(
      "href",
      `/i/${IDS.queued}`,
    );
    const done = list.getByRole("listitem").filter({ hasText: "Rate-limit the public API" });
    await expect(done).toContainText("Both are about “public”");
  } finally {
    await f.stop();
  }
});

test("ui: a title note shows under the title", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, "Fix settings");
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(form(page).getByRole("note")).toHaveText("The title is shorter than a user story");
  } finally {
    await f.stop();
  }
});

test("ui: with no match the intent is created at once", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, UNIQUE);
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/i\/261109-\d{4}-1$/);
    await expect(form(page)).toHaveCount(0);
    expect(f.fixture.calls.map((c) => c.action).filter((a) => a.endsWith("Intent"))).toEqual([
      "checkIntent",
      "createIntent",
    ]);
  } finally {
    await f.stop();
  }
});

test("ui: matches offer create anyway, add to this one and cancel", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, OVERLAPPING);
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    const d = form(page);
    await expect(d.getByRole("button", { name: "Create anyway" })).toBeVisible();
    await expect(d.getByRole("button", { name: "Add my text to this one" })).toHaveCount(1);
    await expect(d.getByRole("button", { name: "Cancel" })).toBeVisible();
    await d.getByRole("button", { name: "Create anyway" }).click();
    await expect(page).toHaveURL(/\/i\/261109-\d{4}-1$/);
  } finally {
    await f.stop();
  }
});

test("ui: done and PR matches offer no add", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, DONE_OVERLAP);
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    const list = form(page).getByRole("region", { name: "Possible overlaps" });
    await expect(list.getByRole("listitem").filter({ hasText: "Sign in with GitHub" })).toContainText("Done");
    await expect(list.getByRole("button", { name: "Add my text to this one" })).toHaveCount(0);
    await expect(form(page).getByRole("button", { name: "Create anyway" })).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: a match past design offers no add and says to write a new intent", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, "Towercab limits requests to the public interface");
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    const item = form(page).getByRole("listitem").filter({ hasText: "Rate-limit the public API" });
    await expect(item).toContainText("Already past design. Write a new intent and link");
    await expect(item.getByRole("link", { name: IDS.plan })).toHaveAttribute("href", `/i/${IDS.plan}`);
    await expect(item.getByRole("button")).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: a contributor is offered propose anyway and no add", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base, "contributor");
    await fill(page, OVERLAPPING);
    await form(page).getByRole("button", { name: "Propose", exact: true }).click();
    await expect(form(page).getByRole("button", { name: "Propose anyway" })).toBeVisible();
    await expect(form(page).getByRole("button", { name: "Add my text to this one" })).toHaveCount(0);
    await expect(form(page).getByRole("button", { name: "Create anyway" })).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: cancel keeps the typed text", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, OVERLAPPING);
    await form(page).getByLabel("Problem").fill("Nobody sees the status.");
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await form(page).getByRole("button", { name: "Cancel" }).click();
    await expect(form(page).getByLabel("Title")).toHaveValue(OVERLAPPING);
    await expect(form(page).getByLabel("Problem")).toHaveValue("Nobody sees the status.");
    // Closing the form and opening it again keeps it too.
    await form(page).getByRole("button", { name: "Cancel" }).click();
    await expect(form(page)).toHaveCount(0);
    await page.getByRole("button", { name: "New intent" }).click();
    await expect(form(page).getByLabel("Title")).toHaveValue(OVERLAPPING);
    expect(f.fixture.calls.filter((c) => c.action === "createIntent")).toEqual([]);
  } finally {
    await f.stop();
  }
});

test("ui: a failed check offers create without the check", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, "FAIL the check please");
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(form(page).getByRole("alert")).toContainText("The overlap check failed: it timed out");
    await expect(form(page)).toContainText("your intent is written without the check");
    await expect(form(page).getByRole("button", { name: "Cancel" })).toBeVisible();
    await form(page).getByRole("button", { name: "Create without the check" }).click();
    await expect(page).toHaveURL(/\/i\/261109-\d{4}-1$/);
  } finally {
    await f.stop();
  }
});

test("ui: a created intent opens its page", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, UNIQUE);
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/i\/261109-\d{4}-1$/);
    await expect(page.getByRole("status").filter({ hasText: /^Created 261109-/ })).toBeVisible();
    await expect(page.locator("main")).toContainText(UNIQUE);
    // The line is said once: it goes away when dismissed.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText(/^Created 261109-/)).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: adding to an intent opens that intent", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, OVERLAPPING);
    await form(page).getByLabel("Constraints").fill("Keep it small");
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await form(page).getByRole("button", { name: "Add my text to this one" }).click();
    await expect(page).toHaveURL(`${f.base}/i/${IDS.queued}`);
    await expect(page.getByRole("status").filter({ hasText: `Added to ${IDS.queued}.` })).toBeVisible();
    expect(f.fixture.calls.find((c) => c.action === "createIntent")).toMatchObject({ intent: IDS.queued });
  } finally {
    await f.stop();
  }
});

test("ui: a proposal shows its pull request and the Inbox", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base, "contributor");
    await fill(page, `${UNIQUE} PROPOSAL`);
    await form(page).getByRole("button", { name: "Propose", exact: true }).click();
    await expect(page).toHaveURL(`${f.base}/`);
    const said = page.getByRole("status").filter({ hasText: /^Proposed 261109-/ });
    await expect(said).toContainText("A maintainer will accept or close it.");
    await expect(said.getByRole("link", { name: "Open the pull request" })).toHaveAttribute(
      "target",
      "_blank",
    );
  } finally {
    await f.stop();
  }
});

test("ui: the form keeps its text after a refusal", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await fill(page, `${UNIQUE} REFUSE`);
    await form(page).getByLabel("Problem").fill("It stays.");
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(form(page).getByRole("alert")).toContainText("The intents repo refused the push");
    await expect(form(page).getByLabel("Title")).toHaveValue(`${UNIQUE} REFUSE`);
    await expect(form(page).getByLabel("Problem")).toHaveValue("It stays.");
    // After a success the text is dropped.
    await form(page).getByLabel("Title").fill(UNIQUE);
    await form(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/i\/261109-/);
    await page.getByRole("button", { name: "New intent" }).click();
    await expect(form(page).getByLabel("Title")).toHaveValue("");
    await expect(form(page).getByLabel("Problem")).toHaveValue("");
  } finally {
    await f.stop();
  }
});

test("ui: the new intent form works by keyboard", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await openForm(page, f.base);
    await expect(form(page).getByLabel("Repo")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await expect(form(page).getByLabel("Title")).toBeFocused();
    await page.keyboard.type(UNIQUE);
    await page.keyboard.press("Tab");
    // Urgency: the first choice takes Space; the arrow keys move between the choices.
    await page.keyboard.press("Space");
    await expect(form(page).getByRole("group", { name: "Urgency" }).locator(".seg.current")).toHaveText("1");
    await page.keyboard.press("ArrowRight");
    await expect(form(page).getByRole("group", { name: "Urgency" }).getByRole("button").nth(1)).toBeFocused();
    // Escape closes the form and the focus goes back.
    await page.keyboard.press("Escape");
    await expect(form(page)).toHaveCount(0);
    await page.getByRole("button", { name: "New intent" }).focus();
    await page.keyboard.press("Enter");
    await expect(form(page).getByLabel("Title")).toHaveValue(UNIQUE);
    // Enter in the title submits the form.
    await form(page).getByLabel("Title").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/i\/261109-/);
  } finally {
    await f.stop();
  }
});

test("ui: the new intent screenshots", async ({ browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  const f = await inboxFixture();
  try {
    for (const m of [
      { mode: "light", scheme: "light" as const, viewport: { width: 1280, height: 900 } },
      { mode: "dark", scheme: "dark" as const, viewport: { width: 1280, height: 900 } },
      { mode: "mobile", scheme: "light" as const, viewport: PHONE },
    ]) {
      const ctx = await browser.newContext({
        colorScheme: m.scheme,
        viewport: m.viewport,
        deviceScaleFactor: m.mode === "mobile" ? 2 : 1,
        isMobile: m.mode === "mobile",
        hasTouch: m.mode === "mobile",
      });
      const page = await ctx.newPage();
      await openForm(page, f.base);
      await expect(form(page)).toBeVisible();
      await page.screenshot({ path: join(SHOTS, `new-intent-${m.mode}.png`) });
      await fill(page, OVERLAPPING);
      await form(page).getByRole("button", { name: "Create", exact: true }).click();
      await expect(form(page).getByRole("region", { name: "Possible overlaps" })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `the form scrolls sideways on ${m.mode}`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(SHOTS, `new-intent-overlaps-${m.mode}.png`) });
      await ctx.close();
    }
  } finally {
    await f.stop();
  }
});
