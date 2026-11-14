// INT-76: an intent's kind is one of five values, and only `setField` writes it.

import { expect, test } from "vitest";
import { IntentFile } from "../../src/intents/intent.ts";

const WITH = (kind: string) => `---
repo: towercab
u: 3
i: 3
kind: ${kind}
source: me
---

# Intent: A thing
`;

test("intents: kind is one of five values", () => {
  for (const k of ["feature", "bugfix", "refactor", "infra", "spec-only"]) {
    expect(IntentFile.parse(WITH(k)).intent.kind).toBe(k);
  }
  const plain = IntentFile.parse("---\nrepo: towercab\n---\n\n# Intent: A thing\n");
  expect(plain.intent.kind).toBeNull();
});

test("intents: an unknown kind makes the intent unreadable", () => {
  expect(() => IntentFile.parse(WITH("chore"))).toThrow(
    /kind must be one of feature, bugfix, refactor, infra, spec-only/,
  );
  expect(() => IntentFile.parse(WITH("3"))).toThrow(/kind must be one of/);
  const f = IntentFile.parse(WITH("bugfix"));
  expect(() => f.setField("kind", "chore")).toThrow(/kind must be one of/);
});

test("intents: setting kind keeps other lines", () => {
  const text = `---
repo: towercab
u: 3   # urgent
i: 3
source: me
---

# Intent: A thing

Body.
`;
  const f = IntentFile.parse(text);
  f.setField("kind", "bugfix");
  expect(f.render()).toBe(text.replace("source: me\n", "source: me\nkind: bugfix\n"));
  f.setField("kind", "feature");
  expect(f.render()).toBe(text.replace("source: me\n", "source: me\nkind: feature\n"));
  f.removeField("kind");
  expect(f.render()).toBe(text);
});
