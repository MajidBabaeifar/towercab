// How the owner's reply to a test question is read (PIP-138, PIP-139), what Towercab says back
// (PIP-140) and reversing a refusal (PIP-141).

import { expect, test } from "vitest";
import {
  answerTest,
  blockedTests,
  parseAllow,
  readingReply,
  readReply,
  reverseRefusals,
  sortTestRequests,
  testQuestion,
} from "../../src/pipeline/access.ts";

const A = "tests/a.test.ts";
const B = "tests/b.test.ts";
const ask = { path: A, why: "w", rest: [] };

// Replies of the shape that were all recorded as refusals on 2026-11-04 (261031-1714-5).
const FIFTEEN = [
  "Yes, allow tests/machine.test.ts … Keep every existing transition test's meaning",
  "Yes, allow tests/machine.test.ts, extend, don't drop checks",
  "Yes, allow tests/loop.test.ts. Keep the existing assertions, do not weaken them",
  "Yes, allow tests/cli.test.ts without removing any case",
  "Yes — allow tests/db.test.ts, but never delete a test",
  "Allow tests/pipeline/verify.test.ts, keep each check's meaning",
  "Allow tests/ui/state.test.ts; don't drop checks",
  "OK, tests/github/events.test.ts, keep every event case",
  "Ok, go ahead, but not the helpers",
  "Okay: tests/priority.test.ts, no renames",
  "Approve tests/intents/store.test.ts, keep its meaning",
  "Approved, extend only, don't touch the other tests",
  "Go ahead, keep the old cases and add new ones",
  "yes. no deletions though",
  "YES, with no change to what the old tests assert",
];

test("access: a reply starting with yes allows even with a condition", () => {
  const r = readReply("Yes, but keep every existing test's meaning", [A]);
  expect(r).toMatchObject({ allowed: [A], refused: [], undecided: [] });
  expect(r.conditions).toBe("but keep every existing test's meaning");
  // A bare allow has no conditions.
  expect(readReply("Allow this change", [A]).conditions).toBe("");
});

test("access: the fifteen replies of 261031-1714-5 read as allow", () => {
  expect(FIFTEEN).toHaveLength(15);
  for (const reply of FIFTEEN) {
    expect(readReply(reply, [A]).allowed, reply).toEqual([A]);
  }
});

test("access: a reply starting with no refuses", () => {
  for (const reply of [
    "No, keep it",
    "no",
    "No.",
    "Refuse this one",
    "Don't",
    "dont do it",
    "Don’t allow it",
  ]) {
    expect(readReply(reply, [A]), reply).toMatchObject({ refused: [A], allowed: [], undecided: [] });
  }
  // Words later in the reply never turn a yes into a no, nor a no into a yes.
  expect(readReply("No, allow nothing", [A]).allowed).toEqual([]);
});

test("access: a reply starting with keep refuses", () => {
  for (const reply of ["Keep the test as it is", "keep it", "Keep all as they are"]) {
    expect(readReply(reply, [A]).refused, reply).toEqual([A]);
  }
});

test("access: only whole first words refuse", () => {
  for (const reply of ["Not sure", "Nothing against it, go ahead", "Nope", "Noted", "Keeping", "Okayish"]) {
    expect(readReply(reply, [A]), reply).toMatchObject({ refused: [], allowed: [], undecided: [A] });
  }
});

test("access: an unclear reply is asked again", () => {
  for (const reply of ["maybe", "What does it change?", "", "   ", undefined, null]) {
    expect(readReply(reply, [A]).undecided, String(reply)).toEqual([A]);
  }
  const r = answerTest(ask, {}, "maybe");
  // Nothing is recorded: not an allow, not a refusal.
  expect(r.patch).toEqual({});
  expect(r.read.undecided).toEqual([A]);
});

test("pipeline: the test question options start with the word they are read by", () => {
  const q = testQuestion({ path: A, why: "w" });
  const [yes, no] = q.options.map((o) => o.option);
  expect(readReply(yes, [A]).allowed).toEqual([A]);
  expect(no).toBe("No, keep the test as it is");
  expect(readReply(no, [A]).refused).toEqual([A]);
});

test("pipeline: conditions after a yes reach the worker", () => {
  const reply = "Yes, allow tests/a.test.ts. Keep every existing transition test's meaning";
  const r = answerTest(ask, {}, reply);
  expect(r.patch).toEqual({ testAllowed: [{ path: A, why: "w" }] });
  expect(r.note).toContain("allowed you to change tests/a.test.ts, on these conditions:");
  expect(r.note).toContain("Keep every existing transition test's meaning");
  // The full reply is quoted too.
  expect(r.note).toContain(`"${reply}"`);
  // A bare yes adds no conditions line.
  expect(answerTest(ask, {}, "yes").note).toBe(`The owner allowed you to change ${A}.`);
});

test("pipeline: an unclear reply records no refusal", () => {
  const r = answerTest(ask, {}, "Not sure");
  expect(r.patch).not.toHaveProperty("refusedTests");
  expect(r.patch).not.toHaveProperty("testAllowed");
  expect(r.note).toBe("");
  expect(readingReply(r.read)).toContain("Reply starting with yes or no");
});

test("pipeline: undecided files of a batch stay asked", () => {
  // A reply naming one file decides that one; the other stays asked, not refused.
  expect(readReply(`Yes, ${A} only`, [A, B])).toMatchObject({ allowed: [A], refused: [], undecided: [B] });
  expect(readReply(`No, keep ${B}`, [A, B])).toMatchObject({ allowed: [], refused: [B], undecided: [A] });
  // A bare yes allows all asked; an unclear one decides none.
  expect(readReply("yes", [A, B]).allowed).toEqual([A, B]);
  expect(readReply("hmm", [A, B]).undecided).toEqual([A, B]);
});

test("pipeline: the reply states which tests were allowed and refused", () => {
  const text = readingReply({ allowed: [A], refused: [B], undecided: [] });
  expect(text).toContain(`Allowed: \`${A}\``);
  expect(text).toContain(`Refused: \`${B}\``);
  expect(text).not.toContain("Still asked");
  // Many files: one per line.
  const four = ["a", "b", "c", "d"].map((x) => `tests/${x}.test.ts`);
  expect(readingReply({ allowed: four, refused: [], undecided: [] })).toBe(
    `Allowed:\n${four.map((p) => `- \`${p}\``).join("\n")}`,
  );
});

test("pipeline: the reply lists tests still asked", () => {
  const text = readingReply({ allowed: [A], refused: [], undecided: [B] });
  expect(text).toContain(`Still asked: \`${B}\``);
  expect(text).toContain("Reply starting with yes or no.");
  expect(text).not.toContain("Refused");
});

test("pipeline: the reply tells how to reverse a refusal", () => {
  expect(readingReply({ allowed: [], refused: [A], undecided: [] })).toContain(
    "Reply `allow <path>` to change a refusal.",
  );
  expect(readingReply({ allowed: [A], refused: [], undecided: [] })).not.toContain("to change a refusal");
});

test("pipeline: a reversed refusal leaves the test writable in the next guard rules", () => {
  const refused = answerTest(ask, {}, "No, keep it");
  const d = { ...refused.patch, testNote: refused.note };
  expect(blockedTests([A, B], d)).toEqual([A, B]);
  const r = reverseRefusals(d, [A]);
  expect(r.moved).toEqual([A]);
  const after = { ...d, ...r.patch };
  // Writable, no longer refused, asking again is a grant, and the worker is told.
  expect(blockedTests([A, B], after)).toEqual([B]);
  expect(after.refusedTests).toBeUndefined();
  expect(sortTestRequests([{ path: A, why: "again" }], after, [A]).granted).toEqual([A]);
  expect(String(after.testNote)).toContain(`now allows you to change ${A}`);
});

test("access: reversing a test that was not refused lists the refused ones", () => {
  const d = { refusedTests: [{ path: A, why: "w" }] };
  expect(() => reverseRefusals(d, [B])).toThrow(`${B} was not refused; refused: ${A}`);
  expect(() => reverseRefusals({}, [B])).toThrow("no test is refused");
});

test("access: allow <path> is a reversal only when every word is a path", () => {
  expect(parseAllow(`allow ${A}`)).toEqual([A]);
  expect(parseAllow(`Allow \`${A}\`, ${B}`)).toEqual([A, B]);
  expect(parseAllow("allow this change")).toBeNull();
  expect(parseAllow("Allow it.")).toBeNull();
  expect(parseAllow("yes tests/a.test.ts")).toBeNull();
});
