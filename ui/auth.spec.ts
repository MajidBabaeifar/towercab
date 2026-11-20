// UI-219, UI-223: sign-in, the refused-account screen and the account menu. The fixture server has no `[auth]`,
// so `/api/me` is answered here the way a server with sign-in would; the server side is tests/ui/auth.test.ts.

import { expect, type Page, test } from "@playwright/test";
import { inboxFixture, settle } from "./inbox-helpers.ts";

const UNKNOWN = "This Towercab doesn't know your GitHub account. Ask an admin to add you.";

const me = (over: Record<string, unknown> = {}) => ({
  auth: true,
  login: "ana",
  name: "Ana Diaz",
  role: "maintainer",
  repoRoles: { api: "viewer" },
  telegram: { available: true, linked: false },
  ...over,
});

/** `/api/me` answers from `state.me`: null is a 401. */
async function session(page: Page, state: { me: unknown | null }) {
  await page.route("**/api/me", (route) =>
    state.me === null
      ? route.fulfill({ status: 401, json: { error: "Sign in first." } })
      : route.fulfill({ json: state.me }),
  );
}

test("ui: signed-out visitors see the sign-in screen", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await session(page, { me: null });
    await page.goto(`${f.base}/`);
    const button = page.getByRole("link", { name: "Sign in with GitHub" });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("href", "/api/auth/login");
    await expect(page.locator(".topbar")).toHaveCount(0);
  } finally {
    await f.stop();
  }
});

test("ui: an unknown account sees why it was refused", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await session(page, { me: null });
    await page.goto(`${f.base}/signin?error=${encodeURIComponent(UNKNOWN)}&login=mallory`);
    await expect(page.getByText(UNKNOWN)).toBeVisible();
    await expect(page.getByText("mallory")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: without auth config there is no sign-in", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await page.goto(`${f.base}/`);
    await settle(page);
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveCount(0);
    await expect(page.locator(".account-btn")).toHaveCount(0);
    await expect(page.locator(".topbar")).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: the account menu shows my role and signs out", async ({ page }) => {
  const f = await inboxFixture();
  try {
    const state: { me: unknown | null } = { me: me() };
    await session(page, state);
    await page.route("**/api/auth/logout", (route) => {
      state.me = null;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.getByRole("button", { name: "Ana Diaz" }).click();
    const menu = page.getByRole("menu", { name: "Account" });
    await expect(menu).toContainText("@ana");
    await expect(menu.getByTestId("my-role")).toHaveText("maintainer");
    await expect(menu).toContainText("viewer on api");
    await menu.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: linking telegram shows a one-time code", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await session(page, { me: me() });
    await page.route("**/api/me/telegram", (route) =>
      route.fulfill({ json: { ok: true, code: "A1B2C3D4E5", expiresInMinutes: 10 } }),
    );
    await page.goto(`${f.base}/`);
    await settle(page);
    await page.getByRole("button", { name: "Ana Diaz" }).click();
    await page.getByRole("button", { name: "Link Telegram" }).click();
    await expect(page.locator(".telegram-code")).toHaveText("A1B2C3D4E5");
    await expect(page.getByText("/link A1B2C3D4E5")).toBeVisible();
  } finally {
    await f.stop();
  }
});
