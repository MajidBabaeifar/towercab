// CHAT-1: the intent page's content is the chat's Details panel; tests of that content open it first.

import type { Page } from "@playwright/test";

export async function openDetails(page: Page): Promise<void> {
  await page.waitForSelector(".chat-head");
  const open = page.getByRole("button", { name: "Details", exact: true });
  if (await open.isVisible()) await open.click();
  await page.waitForSelector(".chat-details .page");
}
