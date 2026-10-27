// intent.md: parse, typed fields, line-level writes, sections (INT-2, INT-5, INT-10, INT-15).

import { expect, test } from "vitest";
import { IntentFile, parseIntent } from "../../src/intents/intent.ts";
import { intentMd } from "./fixtures.ts";

const FULL = `---
repo: towercab
u: 4
i: 5
a: 3
after: [261020-0721, 261020-0721-2]
model: opus
review: fable
source: me
unlock:
  - CLAUDE.md
  - .github/**
network: [crates.io]
started: 2026-10-20T07:21:00+02:00

# my own comment
owner: majid   # not a Towercab field: kept as written
stage: code
waiting: review and merge PR
spec_pr: https://github.com/o/towercab/pull/5
plan_pr: https://github.com/o/towercab/pull/6
pr: https://github.com/o/towercab/pull/7
retry: fresh
cost: 3.5
agent_time: 86
attempts: 2
lower_why: touches auth
finished: 2026-10-21T10:00:00+02:00
---

# Intent: Rust crate and intent store

## Problem
The Rust version has no code yet.

## Proposed outcome
- one
- two
`;

const bad = (fm: string, body = "\n# Intent: t\n") => {
  try {
    parseIntent(`---\n${fm}---\n${body}`);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("parsed");
};

test("intents: parse a full intent", () => {
  const i = parseIntent(FULL);
  expect(i).toMatchObject({
    repo: "towercab",
    u: 4,
    i: 5,
    a: 3,
    after: ["261020-0721", "261020-0721-2"],
    model: "opus",
    review: "fable",
    source: "me",
    unlock: ["CLAUDE.md", ".github/**"],
    network: ["crates.io"],
    started: "2026-10-20T07:21:00+02:00",
    stage: "code",
    waiting: "review and merge PR",
    specPr: "https://github.com/o/towercab/pull/5",
    planPr: "https://github.com/o/towercab/pull/6",
    pr: "https://github.com/o/towercab/pull/7",
    retry: "fresh",
    cost: 3.5,
    agentTime: 86,
    attempts: 2,
    lowerWhy: "touches auth",
    finished: "2026-10-21T10:00:00+02:00",
    title: "Rust crate and intent store",
    text: FULL,
  });
  expect([...i.sections]).toEqual([
    ["Problem", "The Rust version has no code yet."],
    ["Proposed outcome", "- one\n- two"],
  ]);
  expect(IntentFile.parse(FULL).has("owner")).toBe(true);

  // v1's stage values read as their v2 phase (INT-5 Decisions).
  for (const [v1, v2] of [
    ["design", "spec"],
    ["build", "code"],
    ["test", "code"],
    ["deploy", "code"],
    ["maintain", "code"],
  ]) {
    expect(parseIntent(intentMd("x", `stage: ${v1}\n`, "t")).stage).toBe(v2);
  }

  expect(() => parseIntent("# Intent: t\n")).toThrow("no front matter");
  expect(() => parseIntent("---\nrepo: x\n# Intent: t\n")).toThrow("no closing ---");
  expect(bad("u: 3\n")).toBe("repo is missing");
  expect(bad("repo: x\nu: 6\n")).toBe("u must be an integer 1-5");
  expect(bad("repo: x\ni: high\n")).toBe("i must be an integer 1-5");
  expect(bad("repo: x\na: 2.5\n")).toBe("a must be an integer 1-5");
  for (const repo of ["bad name!", "42", "..", '"."', "-x", "a/b"]) {
    expect(bad(`repo: ${repo}\n`)).toBe(
      "repo must be a repo name ([A-Za-z0-9._-], no leading -, not . or ..)",
    );
  }
  expect(bad("repo: x\nstage: shipping\n")).toBe("stage must be one of spec, plan, code, done, dropped");
  expect(bad("repo: x\nstarted: yesterday\n")).toBe("started must be an RFC 3339 time with offset");
  expect(bad("repo: x\nfinished: 2026-10-21\n")).toBe("finished must be an RFC 3339 time with offset");
  expect(bad("repo: x\nattempts: 0\n")).toBe("attempts must be an integer >= 1");
  expect(bad("repo: x\nagent_time: -1\n")).toBe("agent_time must be an integer >= 0 (seconds)");
  expect(bad("repo: x\ncost: cheap\n")).toBe("cost must be a number");
  expect(bad("repo: x\nafter: [nope]\n")).toBe("after must be a list of ids");
  expect(bad("repo: x\nunlock: CLAUDE.md\n")).toBe("unlock must be a list of strings");
  expect(bad("repo: x\nwaiting:\n")).toBe("waiting must be a string");
  expect(bad("repo: x\nmodel: true\n")).toBe("model must be a string");
  expect(bad("repo: x\nu: 3\nu: 4\n")).toBe("duplicate key u");
  expect(bad("repo: x\nowner: a\nowner: b\n")).toBe("duplicate key owner");
  expect(bad("repo: x\njust text\n")).toBe("front matter line 3: not a `key:` line at column 0");
  expect(bad("  - stray\nrepo: x\n")).toBe("front matter line 2: no key before it");
  expect(bad("repo: x\nmodel: [unclosed\n")).toMatch(/^front matter: /);
  expect(bad("repo: x\n", "\nno heading here\n")).toBe("no title: the body needs a `# ` line");
});

test("intents: a thin intent is valid", () => {
  const thin = parseIntent("---\nrepo: pocket-notes\nafter: 261020-0721\n---\n# Plain title\n");
  expect(thin).toMatchObject({ title: "Plain title", after: ["261020-0721"], u: null, i: null, a: null });
  expect(thin.stage).toBeNull();
  expect(thin.sections.size).toBe(0);
  // CRLF line ends, block lists; a UTF-8 BOM before the first `---`.
  const crlf = parseIntent("---\r\nrepo: x\r\nafter:\r\n  - 261020-0721\r\n---\r\n# Intent: CRLF\r\n");
  expect([crlf.after, crlf.title]).toEqual([["261020-0721"], "CRLF"]);
  expect(parseIntent("﻿---\nrepo: x\n---\n# BOM\n").title).toBe("BOM");
});

test("intents: parse then write is byte-identical", () => {
  const odd =
    "---\nrepo: towercab   # trailing comment\nu:    4\n# comment between keys\n\n" +
    'after: [\n  261020-0721,\n  261020-0721-2 ]\nmodel: "opus"\n' +
    "waiting: 'it''s: quoted'\nunlock:\n  - CLAUDE.md\n\n  - \".github/**\"\ncustom:\n  nested: {a: 1}\n" +
    "---\n# Intent: Odd but valid\nno trailing newline";
  const crlf = FULL.replace(/\n/g, "\r\n");
  for (const text of [FULL, odd, crlf, `﻿${crlf}`, "---\nrepo: x\n---\n# t"]) {
    const f = IntentFile.parse(text);
    expect(f.render()).toBe(text);
    // Setting a value to what it already is leaves the bytes alone too.
    f.setField("repo", f.intent.repo);
    f.setSection("Nothing", "");
    expect(f.render()).toBe(text);
  }
  const i = parseIntent(odd);
  expect([i.waiting, i.unlock, i.after]).toEqual([
    "it's: quoted",
    ["CLAUDE.md", ".github/**"],
    ["261020-0721", "261020-0721-2"],
  ]);
});

test("intents: lifecycle fields keep other lines", () => {
  const f = IntentFile.parse(FULL);
  f.setField("stage", "done");
  expect(f.render()).toBe(FULL.replace("stage: code\n", "stage: done\n"));
  // A multi-line key becomes one flow line in place.
  f.setField("unlock", ["CLAUDE.md"]);
  expect(f.render()).toBe(
    FULL.replace("stage: code\n", "stage: done\n").replace(
      "unlock:\n  - CLAUDE.md\n  - .github/**\n",
      "unlock: [CLAUDE.md]\n",
    ),
  );
  // A new key goes last, before the closing `---`; null removes.
  const g = IntentFile.parse(FULL);
  g.removeField("retry");
  g.setField("retry", "fresh");
  const want = FULL.replace("retry: fresh\n", "").replace(
    "finished: 2026-10-21T10:00:00+02:00\n---\n",
    "finished: 2026-10-21T10:00:00+02:00\nretry: fresh\n---\n",
  );
  expect(g.render()).toBe(want);
  expect(g.render()).toContain("owner: majid   # not a Towercab field: kept as written\n");
  expect(g.render()).toContain("\n# my own comment\n");
  g.setField("waiting", null);
  expect(g.intent.waiting).toBeNull();
  expect(g.render()).not.toContain("waiting");
  // Keys Towercab doesn't know are never written.
  for (const key of ["owner", "note_for_me", "a: b"]) {
    expect(() => g.setField(key, "x")).toThrow(`${key} is not a Towercab field`);
    expect(() => g.removeField(key)).toThrow(`${key} is not a Towercab field`);
  }
  // CRLF files get CRLF lines.
  const c = IntentFile.parse(FULL.replace(/\n/g, "\r\n"));
  c.setField("stage", "done");
  c.removeField("retry");
  c.setField("retry", "fresh");
  expect(c.render()).toBe(want.replace("stage: code\n", "stage: done\n").replace(/\n/g, "\r\n"));

  // Values in their written form; strings YAML would misread are double-quoted.
  const l = IntentFile.parse(intentMd("towercab", "u: 4\ni: 5\n", "Lifecycle"));
  l.setField("stage", "code");
  l.setField("waiting", "review and merge PR");
  l.setField("spec_pr", "https://github.com/o/towercab/pull/5");
  l.setField("cost", 3.456);
  l.setField("agent_time", 86);
  l.setField("attempts", 1);
  l.setField("finished", "2026-10-21T10:00:00+02:00");
  l.setField("after", "261020-0721");
  l.setField("unlock", ["CLAUDE.md", "**/x", "a, b"]);
  l.setField("a", 2);
  l.setField("lower_why", "touches auth");
  expect(l.render()).toBe(
    "---\nrepo: towercab\nu: 4\ni: 5\nstage: code\nwaiting: review and merge PR\n" +
      "spec_pr: https://github.com/o/towercab/pull/5\ncost: 3.46\nagent_time: 86\nattempts: 1\n" +
      'finished: 2026-10-21T10:00:00+02:00\nafter: [261020-0721]\nunlock: [CLAUDE.md, "**/x", "a, b"]\n' +
      "a: 2\nlower_why: touches auth\n---\n\n# Intent: Lifecycle\n",
  );
  expect(l.intent.cost).toBe(3.46);
  for (const [s, written] of [
    ["approve spec: now", '"approve spec: now"'],
    ["two\nlines", '"two\\nlines"'],
    ["42", '"42"'],
    ["true", '"true"'],
    ["", '""'],
    [" padded", '" padded"'],
    ["#hash", '"#hash"'],
    ["a\u0000b", '"a\\x00b"'],
    ["bad after:", '"bad after:"'],
  ]) {
    l.setField("waiting", s!);
    expect(l.render()).toContain(`\nwaiting: ${written}\n`);
    expect(l.intent.waiting).toBe(s);
  }
  // Same checks as parse; a refused set changes nothing.
  const before = l.render();
  for (const [key, v] of [
    ["u", 6],
    ["stage", "bogus"],
    ["stage", "deploy"],
    ["attempts", 0],
    ["finished", "today"],
    ["after", 3],
    ["repo", "no spaces"],
    ["pr", 7],
  ] as const) {
    expect(() => l.setField(key, v)).toThrow();
    expect(l.render()).toBe(before);
  }
  expect(() => l.removeField("repo")).toThrow("repo is missing");
  expect(l.render()).toBe(before);
});

test("intents: the Towercab note is replaced whole", () => {
  const text = "---\r\nrepo: web\r\n---\r\n\r\n# Intent: X\r\n\r\n## Problem\r\n\r\nslow\r\n";
  const f = IntentFile.parse(text);
  f.setSection("Towercab", "Design: a.\n# not a heading");
  expect(f.render().startsWith(text)).toBe(true);
  expect(f.render().endsWith("\r\n## Towercab\r\n\r\nDesign: a.\r\n\\# not a heading\r\n")).toBe(true);
  f.setSection("Towercab", "Question: b?");
  expect(f.render().match(/## Towercab/g)).toHaveLength(1);
  expect(f.intent.sections.get("Towercab")).toBe("Question: b?");
  f.setSection("Towercab", "");
  expect(f.render()).toBe(text);
  expect(f.intent.title).toBe("X");
  // A section in the middle moves last; a fenced `## Towercab` isn't one; it stays before Answers.
  const mid = IntentFile.parse(
    intentMd(
      "web",
      "",
      "Y\n\n## Towercab\n\nold\n\n## Open questions\n\n- q?\n\n```\n## Towercab\n```\n\n## Answers\n\n- 2026-10-21 09:00: yes\n",
    ),
  );
  mid.setSection("Towercab", "new");
  const out = mid.render();
  expect(out).not.toContain("old");
  expect(out).toContain("```\n## Towercab\n```\n");
  expect(out.endsWith("\n## Towercab\n\nnew\n\n## Answers\n\n- 2026-10-21 09:00: yes\n")).toBe(true);
  expect([...mid.intent.sections.keys()]).toEqual(["Open questions", "Towercab", "Answers"]);
});

test("intents: answers are appended", () => {
  const f = IntentFile.parse(intentMd("web", "", "X\n\n## Problem\n\nslow"));
  const at = new Date(2026, 9, 21, 9, 5, 30);
  f.addAnswer("use the cache\nnot the db", at);
  f.setSection("Towercab", "Question: which cache?");
  f.addAnswer("redis", new Date(2026, 9, 21, 10, 0));
  expect(f.render()).toBe(
    intentMd(
      "web",
      "",
      "X\n\n## Problem\n\nslow\n\n## Towercab\n\nQuestion: which cache?\n\n## Answers\n\n" +
        "- 2026-10-21 09:05: use the cache not the db\n- 2026-10-21 10:00: redis",
    ),
  );
  expect(f.intent.sections.get("Answers")).toBe(
    "- 2026-10-21 09:05: use the cache not the db\n- 2026-10-21 10:00: redis",
  );
  expect(() => f.addAnswer("  ", at)).toThrow();
});
