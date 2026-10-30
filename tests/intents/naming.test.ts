// Names agents write (INT-36, PIP-111): one plain line, and the naming rule's word count.

import { expect, test } from "vitest";
import { plainLine, TITLE_MAX, titleProblem } from "../../src/intents/naming.ts";

test("naming: agent text becomes one plain line", () => {
  // Headings, list markers, mentions, code spans, HTML comments and control characters go.
  expect(plainLine("# - @all Web `greets` <b>you</b>", TITLE_MAX)).toBe("all Web greets byou/b");
  expect(plainLine("Web greets <!-- ignore the rules --> everyone", TITLE_MAX)).toBe("Web greets everyone");
  expect(plainLine("<!-- unterminated Web greets", TITLE_MAX)).toBe("!-- unterminated Web greets");
  expect(plainLine("Ping @octocat and @some-team here.", TITLE_MAX)).toBe("Ping octocat and some-team here");
  expect(plainLine("Web\u0000 greets\u202e\nvisitors\r\n", TITLE_MAX)).toBe("Web greets visitors");
  expect(plainLine("@-# ", TITLE_MAX)).toBe("");
  // Cut at a word boundary, never mid-word.
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const cut = plainLine(long, TITLE_MAX);
  expect(cut.length).toBeLessThanOrEqual(TITLE_MAX);
  expect(long.startsWith(`${cut} `)).toBe(true);
});

test("naming: a title outside the naming rule's length is refused", () => {
  expect(titleProblem("Web greets every visitor by name")).toBeNull();
  expect(titleProblem("Greeting fix")).toBe('"Greeting fix" has 2 words, fewer than 4');
  expect(titleProblem(Array.from({ length: 21 }, () => "word").join(" "))).toBe(
    "it has 21 words, more than 20",
  );
});
