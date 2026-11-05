// INT-41, INT-42: the `repos` front matter field of a multi-repo intent.

import { expect, test } from "vitest";
import { IntentFile, parseIntent } from "../../src/intents/intent.ts";
import { intentMd } from "./fixtures.ts";

test("intents: repos lists the other repos", () => {
  const i = parseIntent(intentMd("specfork", "repos: [infra, ci]\n", "Run the backend"));
  expect(i.repo).toBe("specfork");
  expect(i.repos).toEqual(["infra", "ci"]);
  // A block list reads the same.
  const block = parseIntent(intentMd("specfork", "repos:\n  - infra\n  - ci\n", "Run the backend"));
  expect(block.repos).toEqual(["infra", "ci"]);
});

test("intents: repos is optional and a single name works", () => {
  expect(parseIntent(intentMd("specfork", "", "One repo")).repos).toEqual([]);
  expect(parseIntent(intentMd("specfork", "repos: infra\n", "Two repos")).repos).toEqual(["infra"]);
  expect(() => parseIntent(intentMd("specfork", "repos: [ok, -bad]\n", "Bad name"))).toThrow(
    "repos must be a list of repo names (or one name)",
  );
});

test("intents: repos keeps the other lines byte-identical", () => {
  const text = intentMd(
    "specfork",
    "u: 3\n# my note\nowner: majid   # kept\nafter: [261031-1714-5]\n",
    "Keep",
  );
  const f = IntentFile.parse(text);
  f.setField("repos", ["infra", "ci"]);
  expect(f.render()).toBe(
    text.replace("after: [261031-1714-5]\n", "after: [261031-1714-5]\nrepos: [infra, ci]\n"),
  );
  expect(f.intent.repos).toEqual(["infra", "ci"]);
  f.removeField("repos");
  expect(f.render()).toBe(text);
});

test("intents: repos naming the lead is unreadable", () => {
  expect(() => parseIntent(intentMd("specfork", "repos: [infra, specfork]\n", "Lead twice"))).toThrow(
    "repos names the lead repo specfork",
  );
  expect(() => parseIntent(intentMd("specfork", "repos: [infra, infra]\n", "Twice"))).toThrow(
    "repos names infra twice",
  );
});
