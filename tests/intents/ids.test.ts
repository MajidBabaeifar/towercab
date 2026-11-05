// Requirement IDs renumbered inside an intent (PIP-131): only those IDs change, every other byte stays.

import { expect, test } from "vitest";
import { IntentFile } from "../../src/intents/intent.ts";

const TEXT = `---
repo: towercab
u: 3
i: 3
source: me
---

# Intent: Keep PIP-130 as it is in the title? No: PIP-13 and PIP-1300 stay

## Proposed outcome
- spec IDs: PIP-130..132.
- Row PIP-131 gets a test.
- Not an ID: XPIP-130, PIP-1300.

## Affected users and systems
The owner.
`;

test("intents: replacing requirement IDs changes only those IDs", () => {
  const f = IntentFile.parse(TEXT);
  f.replaceInBody(
    new Map([
      ["PIP-130", "PIP-142"],
      ["PIP-131", "PIP-143"],
      ["PIP-132", "PIP-144"],
    ]),
  );
  expect(f.render()).toBe(
    TEXT.replace("PIP-130..132.", "PIP-142..144.")
      .replace("Row PIP-131", "Row PIP-143")
      .replace("Keep PIP-130", "Keep PIP-142"),
  );
});

test("intents: replacing no IDs leaves the file byte-identical", () => {
  const f = IntentFile.parse(TEXT);
  f.replaceInBody(new Map([["PIP-7", "PIP-8"]]));
  expect(f.render()).toBe(TEXT);
});
