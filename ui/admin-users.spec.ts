// UI-222, UI-224: the admin page. `/api/users` is answered from a small in-memory model that applies each
// call the way the server would; the server's rules are tested in tests/users-admin.test.ts.

import { expect, type Page, test } from "@playwright/test";
import { inboxFixture } from "./inbox-helpers.ts";

interface Model {
  users: {
    login: string;
    name: string;
    role: string;
    repoRoles: Record<string, string>;
    disabled: boolean;
    addedBy: string;
    added: number;
    lastSeen: number | null;
  }[];
  team: { team: string; role: string } | null;
  sessions: { hash: string; login: string; created: number; lastSeen: number }[];
  events: { id: number; at: number; actor: string; what: string; login: string; detail: string }[];
}

const person = (login: string, role: string, over: Partial<Model["users"][number]> = {}) => ({
  login,
  name: `${login[0]!.toUpperCase()}${login.slice(1)} Name`,
  role,
  repoRoles: {},
  disabled: false,
  addedBy: "root",
  added: 1,
  lastSeen: 1_700_000_000,
  ...over,
});

function model(): Model {
  return {
    users: [person("root", "admin"), person("ana", "viewer", { repoRoles: { web: "maintainer" } })],
    team: null,
    sessions: [{ hash: "h-ana-1", login: "ana", created: 1_700_000_000, lastSeen: 1_700_000_100 }],
    events: [{ id: 1, at: 1_700_000_000, actor: "root", what: "added", login: "ana", detail: "viewer" }],
  };
}

/** The calls the page made, and a model that follows them. `refuse` answers the next call with an error. */
async function serve(page: Page, m: Model) {
  const calls: Record<string, unknown>[] = [];
  const state = { refuse: "" };
  await page.route("**/api/me", (route) =>
    route.fulfill({ json: { auth: true, login: "root", name: "Root Name", role: "admin", repoRoles: {} } }),
  );
  await page.route("**/api/users", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: m });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    if (state.refuse) return route.fulfill({ status: 422, json: { ok: false, message: state.refuse } });
    if (body.op === "add")
      m.users.push(
        person(String(body.login), String(body.role), {
          repoRoles: body.repoRoles as Record<string, string>,
        }),
      );
    if (body.op === "revoke") m.sessions = m.sessions.filter((s) => s.hash !== body.hash);
    return route.fulfill({ json: { ok: true, message: "Saved." } });
  });
  return { calls, state };
}

test("ui: the admin page lists people with roles and repos", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await serve(page, model());
    await page.goto(`${f.base}/users`);
    const ana = page.locator('tr[data-login="ana"]');
    await expect(ana).toBeVisible();
    await expect(ana.getByLabel("Role of ana")).toHaveValue("viewer");
    await expect(ana.getByLabel("Repo roles of ana")).toHaveValue("web=maintainer");
    await expect(page.locator('tr[data-login="root"]').getByLabel("Role of root")).toHaveValue("admin");
  } finally {
    await f.stop();
  }
});

test("ui: an admin adds a person and sets repo roles", async ({ page }) => {
  const f = await inboxFixture();
  try {
    const { calls } = await serve(page, model());
    await page.goto(`${f.base}/users`);
    const form = page.locator(".users-add");
    await form.getByLabel("GitHub login").fill("newbie");
    await form.locator("select").selectOption("contributor");
    await form.getByLabel("Repo roles").fill("web=maintainer, api=viewer");
    await form.getByRole("button", { name: "Add person" }).click();
    await expect(page.locator('tr[data-login="newbie"]')).toBeVisible();
    expect(calls.at(-1)).toEqual({
      op: "add",
      login: "newbie",
      role: "contributor",
      repoRoles: { web: "maintainer", api: "viewer" },
    });
  } finally {
    await f.stop();
  }
});

test("ui: removing the last admin is refused in the page", async ({ page }) => {
  const f = await inboxFixture();
  try {
    const { state } = await serve(page, model());
    state.refuse = "this is the last admin: add another admin first";
    await page.goto(`${f.base}/users`);
    const root = page.locator('tr[data-login="root"]');
    await root.getByRole("button", { name: "Remove" }).click();
    await root.getByRole("button", { name: "Yes, remove root" }).click();
    await expect(page.getByRole("alert")).toContainText("last admin");
    await expect(root).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: the admin page lists the change history", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await serve(page, model());
    await page.goto(`${f.base}/users`);
    await expect(page.locator(".users-history li")).toHaveCount(1);
    await expect(page.locator(".users-history")).toContainText("root: added ana (viewer)");
  } finally {
    await f.stop();
  }
});

test("ui: the team role list stops at contributor", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await serve(page, model());
    await page.goto(`${f.base}/users`);
    await expect(page.getByLabel("Team role").locator("option")).toHaveCount(2);
    expect(await page.getByLabel("Team role").locator("option").allTextContents()).toEqual([
      "viewer",
      "contributor",
    ]);
  } finally {
    await f.stop();
  }
});

test("ui: security settings are read-only in the page", async ({ page }) => {
  const f = await inboxFixture();
  try {
    await serve(page, model());
    await page.goto(`${f.base}/users`);
    const security = page.locator(".security-settings");
    await expect(security).toContainText("The sandbox and its access rules");
    await expect(security).toContainText("Edit the config file");
    await expect(security.locator("input, select, button")).toHaveCount(0);
    // The budgets are changed in the page.
    await expect(page.getByLabel("Daily budget (USD)")).toBeVisible();
  } finally {
    await f.stop();
  }
});

test("ui: an admin revokes a session", async ({ page }) => {
  const f = await inboxFixture();
  try {
    const { calls } = await serve(page, model());
    await page.goto(`${f.base}/users`);
    const ana = page.locator('tr[data-login="ana"]');
    await expect(ana.locator(".sessions li")).toHaveCount(2);
    await ana.getByRole("button", { name: "Revoke", exact: true }).click();
    expect(calls.at(-1)).toEqual({ op: "revoke", hash: "h-ana-1" });
    await expect(ana).toContainText("none");
  } finally {
    await f.stop();
  }
});
