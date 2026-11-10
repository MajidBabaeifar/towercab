// TG-23: Telegram shows the people part and a link, never the agent part.

import { expect, test } from "vitest";
import { type WaitView, waitText } from "../src/telegram/render.ts";

const view = (o: Partial<WaitView> = {}): WaitView => ({
  intent: "261108-1228-1",
  title: "Show a greeting",
  repo: "web",
  ask: "Merge the change?",
  why: "The review approved.",
  question: false,
  actions: ["merge"],
  onlyYou: false,
  waitId: "1.0",
  head: "abc",
  pr: null,
  base: "main",
  ...o,
});
const LINK = "https://ui.test/?intent=261108-1228-1";
const AGENT = "Files: src/a.ts, src/b.ts\nFindings: a nit";

test("telegram: a card shows the people part and no agent text", () => {
  const text = waitText(view({ people: "Visitors now see a hello. Nothing needs deciding." }), LINK);
  expect(text).toContain("Visitors now see a hello.");
  expect(text).not.toContain("src/a.ts");
  expect(text.endsWith(LINK)).toBe(true);
});

test("telegram: a question message carries the people part and a link", () => {
  const text = waitText(
    view({ question: true, ask: "Answer a question", people: "Pick how totals split." }),
    LINK,
  );
  expect(text).toContain("Pick how totals split.");
  expect(text).toContain("Reply to this message to answer.");
  expect(text.endsWith(LINK)).toBe(true);
});

test("telegram: no details block reaches a message", () => {
  const people = `A short summary.\n<details><summary>Agent context</summary>${AGENT}</details>`;
  // The card carries only its people part (UI-281), but a stray fold must still not be sent whole.
  const text = waitText(view({ people: people.split("\n<details>")[0] }), LINK);
  expect(text).not.toContain("<details>");
  expect(text).not.toContain("Findings");
});
