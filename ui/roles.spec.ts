// UI-220: the page offers only what the signed-in role can do. `/api/me` is answered as a server with
// sign-in would; the server's own refusals are tested in tests/users-api.test.ts.

import { expect, type Page, test } from "@playwright/test";
import { IDS } from "./fixture.ts";
import { inboxFixture, settle } from "./inbox-helpers.ts";

type Role = "viewer" | "contributor" | "maintainer" | "admin";

async function as(page: Page, role: Role) {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      json: {
        auth: true,
        login: "pat",
        name: "Pat Lee",
        role,
        repoRoles: {},
        telegram: { available: false, linked: false },
      },
    }),
  );
}

/** The fixture's `top.role` follows the signed-in role as the new intent button reads it. */
async function topRole(page: Page, role: Role) {
  await page.route("**/api/state", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { top: Record<string, unknown> };
    body.top.role = role === "admin" ? "maintainer" : role;
    await route.fulfill({ response: res, json: body });
  });
}

test("ui: a viewer sees no action buttons", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await as(page, "viewer");
    await topRole(page, "viewer");
    await page.goto(`${f.base}/i/${IDS.code}`);
    await page.waitForSelector(".needs-card");
    await expect(page.locator(".needs-card .card-actions button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New intent" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Pause|Resume)/ })).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: a contributor sees only answer and create", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await as(page, "contributor");
    await topRole(page, "contributor");
    await page.goto(`${f.base}/i/${IDS.question}`);
    await page.waitForSelector(".needs-card");
    await expect(page.getByRole("button", { name: "Send reply" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New intent" })).toBeVisible();
    await page.goto(`${f.base}/i/${IDS.code}`);
    await page.waitForSelector(".needs-card");
    // Nothing on the code approval is enabled for a contributor.
    await expect(page.locator(".needs-card .card-actions button:enabled")).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: a disabled action says which role it needs", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await as(page, "contributor");
    await topRole(page, "contributor");
    await page.goto(`${f.base}/i/${IDS.code}`);
    await page.waitForSelector(".needs-card");
    const merge = page.locator(".needs-card .card-actions button:disabled").first();
    await expect(merge).toBeVisible();
    await expect(merge).toHaveAttribute("title", /^Needs maintainer on \S+ \(you are contributor\)$/);
  } finally {
    await f.stop();
  }
});

test("ui: the admin link shows for admins only", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await as(page, "maintainer");
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page.getByRole("link", { name: "People" })).toHaveCount(0);
    await page.unroute("**/api/me");
    await as(page, "admin");
    await page.reload();
    await settle(page);
    await expect(page.getByRole("link", { name: "People" })).toBeVisible();
  } finally {
    await f.stop();
  }
});
