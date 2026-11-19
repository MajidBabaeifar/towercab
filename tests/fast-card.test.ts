// FAST-10: the intent's Telegram card carries the fast lane line and its progress.

import { expect, test } from "vitest";
import { fastLine, fastProgress } from "../src/fast-lane.ts";
import { buildTrack, type CardView, cardLines } from "../src/telegram/card.ts";

const view = (over: Partial<CardView> = {}): CardView => ({
  intent: "261114-1156",
  mission: 1,
  title: "Fix the login page",
  repo: "web",
  track: buildTrack(2, 0, false),
  status: "Building",
  ask: null,
  question: false,
  onlyYou: false,
  waitId: null,
  final: null,
  link: null,
  ...over,
});

test("telegram: the card shows the fast lane line", () => {
  const line = fastLine({ stage: "build", from_stage: null });
  expect(line).toBe("Fast lane · build, 3 of 6");
  const lines = cardLines(view({ fast: line }));
  expect(lines).toContain("Fast lane · build, 3 of 6");
  // Under the repo, above the status, inside the 28 characters of the block.
  expect(lines.indexOf(line)).toBe(lines.indexOf("web") + 1);
  expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThanOrEqual(28);
  expect(cardLines(view())).not.toContain(line);
  expect(fastProgress({ stage: "blocked", from_stage: "review" })).toBe("review, 5 of 6");
  expect(fastProgress({ stage: "ci", from_stage: null })).toBe("checks, 4 of 6");
});
