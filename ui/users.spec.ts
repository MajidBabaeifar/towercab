// UI-219 to UI-224: sign-in, the page by role, the account menu and the admin page, in Chromium against the
// fixture with sign-in on.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { IDS, serveFixture, servePeople } from "./fixture.ts";

const SHOTS = resolve(process.env.TOWERCAB_SHOTS ?? join(import.meta.dirname, "screenshots"));

async function signedIn(page: Page, w: Awaited<ReturnType<typeof servePeople>>, login: string, path: string) {
  const c = await w.as(login);
  await page.context().addCookies([{ name: c.name, value: c.value, url: w.base }]);
  await page.goto(`${w.base}${path}`);
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
}

test("ui: signed-out visitors see the sign-in screen", async ({ page }) => {
  const w = await servePeople();
  try {
    await page.goto(w.base);
    const button = page.getByRole("link", { name: "Sign in with GitHub" });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute("href", "/auth/login");
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, "signin.png") });
  } finally {
    await w.stop();
  }
});

test("ui: without auth config there is no sign-in", async ({ page }) => {
  const { fixture, server } = await serveFixture(0);
  try {
    await page.goto(`http://localhost:${server.port()}/`);
    await page.waitForSelector(".page");
    await expect(page.getByText("Sign in with GitHub")).toHaveCount(0);
    await expect(page.locator(".account")).toHaveCount(0);
  } finally {
    await server.stop();
    fixture.cleanup();
  }
});

test("ui: a viewer sees no action buttons", async ({ page }) => {
  const w = await servePeople({ people: [{ login: "vi", role: "viewer" }] });
  try {
    await signedIn(page, w, "vi", `/inbox/${IDS.plan}`);
    await page.waitForSelector(".inbox-detail");
    await expect(page.locator(".inbox-detail")).toContainText("Rate-limit the public API");
    await expect(page.getByRole("button", { name: /Merge/ })).toHaveCount(0);
    await expect(page.locator(".inbox-detail .reply")).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, "viewer.png") });
  } finally {
    await w.stop();
  }
});

test("ui: a contributor sees only answer and create", async ({ page }) => {
  const w = await servePeople({ people: [{ login: "co", role: "contributor" }] });
  try {
    await signedIn(page, w, "co", `/inbox/${IDS.question}`);
    await page.waitForSelector(".inbox-detail");
    await expect(page.locator(".inbox-detail .reply textarea")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled(); // empty draft
    await page.goto(`${w.base}/inbox/${IDS.plan}`);
    await page.waitForSelector(".inbox-detail");
    await expect(page.locator(".inbox-detail .reply")).toHaveCount(0);
  } finally {
    await w.stop();
  }
});

test("ui: a disabled action says which role it needs", async ({ page }) => {
  const w = await servePeople({ people: [{ login: "co", role: "contributor" }] });
  try {
    await signedIn(page, w, "co", `/inbox/${IDS.plan}`);
    const merge = page.getByRole("button", { name: /Merge/ });
    await expect(merge).toBeDisabled();
    await expect(merge).toHaveAttribute("title", "Needs maintainer on api (you are contributor)");
  } finally {
    await w.stop();
  }
});

test("ui: the admin link shows for admins only", async ({ page }) => {
  const w = await servePeople({ people: [{ login: "ma", role: "maintainer" }] });
  try {
    await signedIn(page, w, "ma", "/");
    await expect(page.getByRole("link", { name: "People" })).toHaveCount(0);
    const admin = await w.as("owner");
    await page.context().clearCookies();
    await page.context().addCookies([{ name: admin.name, value: admin.value, url: w.base }]);
    await page.goto(`${w.base}/`);
    await page.waitForSelector(".page");
    await expect(page.getByRole("link", { name: "People" })).toBeVisible();
    await page.getByRole("link", { name: "People" }).click();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await expect(page.locator('tr[data-login="ma"]')).toBeVisible();
    await expect(page.locator("[data-security='agent.network']")).toBeVisible();
    await page.screenshot({ path: join(SHOTS, "admin.png"), fullPage: true });
  } finally {
    await w.stop();
  }
});

test("ui: the account menu shows my role and signs out", async ({ page }) => {
  const w = await servePeople({
    people: [{ login: "ma", role: "viewer", repos: { web: "maintainer" }, name: "Mia" }],
  });
  try {
    await signedIn(page, w, "ma", "/");
    await page.getByRole("button", { name: "Mia" }).click();
    await expect(page.locator(".account-menu")).toContainText("viewer");
    await expect(page.locator(".account-menu")).toContainText("maintainer on web");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  } finally {
    await w.stop();
  }
});

test("ui: linking telegram shows a one-time code", async ({ page }) => {
  const w = await servePeople({ people: [{ login: "ma", role: "maintainer" }] });
  try {
    await signedIn(page, w, "ma", "/");
    await page.getByRole("button", { name: "ma" }).click();
    await page.getByRole("button", { name: "Link Telegram" }).click();
    await expect(page.locator(".telegram-code code")).toHaveText(/\S{4,}/);
  } finally {
    await w.stop();
  }
});
