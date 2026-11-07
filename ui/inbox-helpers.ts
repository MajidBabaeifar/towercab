// Shared by the Inbox specs: a fixture on its own port, so a test's clicks don't reach another's.

import type { Page } from "@playwright/test";
import { type Fixture, serveFixture } from "./fixture.ts";

export const PHONE = { width: 375, height: 812 };

export async function inboxFixture(
  o: { proposed?: boolean; crowded?: boolean; empty?: boolean } = { proposed: true },
) {
  const { fixture, server } = await serveFixture(0, o);
  const base = `http://localhost:${server.port()}`;
  return {
    fixture: fixture as Fixture,
    base,
    async stop() {
      await server.stop();
      fixture.cleanup();
    },
  };
}

export async function settle(page: Page) {
  await page.waitForSelector(".page");
  await page.waitForLoadState("networkidle");
  await page.waitForSelector(".inbox-row, .calm");
}

/** The selected row's key, from its id. */
export const selectedKey = (page: Page) =>
  page
    .locator(".inbox-row[aria-selected=true]")
    .getAttribute("id")
    .then((id) => id?.replace("inbox-row-", "") ?? "");
