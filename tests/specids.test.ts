// The pure requirement-ID helpers (PIP-130, PIP-131, PIP-132).

import { expect, test } from "vitest";
import {
  addedIds,
  applyMap,
  formatIds,
  headingIds,
  idProblems,
  moveIds,
  nextFree,
  parseIds,
  yields,
} from "../src/specids.ts";

test("specids: ranges and lists are read as IDs", () => {
  expect(parseIds("PIP-130..132, UI-4")).toEqual(["PIP-130", "PIP-131", "PIP-132", "UI-4"]);
  expect(parseIds("PIP-3..PIP-4 and PIP-3")).toEqual(["PIP-3", "PIP-4"]);
  expect(parseIds("none yet")).toEqual([]);
});

test("specids: IDs are written as the shortest list", () => {
  expect(formatIds(["PIP-142", "PIP-143", "PIP-144", "UI-4", "PIP-9"])).toBe("PIP-142..144, UI-4, PIP-9");
});

test("specids: headings and added headings are found", () => {
  expect(headingIds("### PIP-1 · A\n\ntext\n### PIP-2 · B\n#### PIP-3\n")).toEqual(["PIP-1", "PIP-2"]);
  expect(addedIds("+### PIP-5 · New\n ### PIP-6 · Old\n-### PIP-7 · Gone\n+### PIP-5 · New\n")).toEqual([
    "PIP-5",
  ]);
});

test("specids: the next free number follows the highest taken one", () => {
  expect(nextFree("PIP", ["PIP-1", "PIP-141", "UI-9"], 2)).toEqual(["PIP-142", "PIP-143"]);
  expect(nextFree("NEW", ["PIP-1"], 1)).toEqual(["NEW-1"]);
  expect(moveIds(["PIP-130", "PIP-131"], ["PIP-141", "PIP-130"])).toEqual(
    new Map([
      ["PIP-130", "PIP-142"],
      ["PIP-131", "PIP-143"],
    ]),
  );
});

test("specids: a replacement touches whole IDs only", () => {
  const map = new Map([
    ["PIP-13", "PIP-20"],
    ["PIP-130", "PIP-142"],
    ["PIP-131", "PIP-143"],
  ]);
  expect(applyMap("see PIP-13, PIP-130 and PIP-1300 or XPIP-13", map)).toBe(
    "see PIP-20, PIP-142 and PIP-1300 or XPIP-13",
  );
  expect(applyMap("spec IDs: PIP-130..131.", map)).toBe("spec IDs: PIP-142..143.");
  expect(applyMap("Live: PIP-1..12", map)).toBe("Live: PIP-1..12");
  expect(applyMap("PIP-130 stays", new Map())).toBe("PIP-130 stays");
});

test("specids: the unapproved PR yields, else the later one", () => {
  const a = { number: 10, approved: false };
  const b = { number: 20, approved: true };
  expect(yields(a, b)).toBe(true);
  expect(yields(b, a)).toBe(false);
  expect(yields({ number: 10, approved: false }, { number: 20, approved: false })).toBe(false);
  expect(yields({ number: 20, approved: false }, { number: 10, approved: false })).toBe(true);
  expect(yields({ number: null, approved: false }, { number: 10, approved: false })).toBe(true);
});

test("specids: problems name the ID, the file and the reason", () => {
  const facts = {
    head: [
      { id: "PIP-1", file: "specs/p.md" },
      { id: "PIP-2", file: "specs/p.md" },
      { id: "PIP-3", file: "specs/p.md" },
      { id: "PIP-3", file: "specs/q.md" },
    ],
    mergeBase: new Set(["PIP-1"]),
    base: new Set(["PIP-1", "PIP-2"]),
    open: [{ number: 7, ids: ["PIP-3"] }],
  };
  expect(idProblems(facts)).toEqual([
    "PIP-2 (specs/p.md): added here, but the base branch already has this ID",
    "PIP-3: 2 headings carry this ID (specs/p.md, specs/q.md)",
    "PIP-3 (specs/p.md): also added by open pull request #7",
  ]);
  expect(idProblems({ ...facts, head: [{ id: "PIP-1", file: "specs/p.md" }] })).toEqual([]);
});
