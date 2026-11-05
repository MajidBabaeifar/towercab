// SHIP-31: the pure rules that decide what a release PR is.

import { expect, test } from "vitest";
import {
  decideRelease,
  isBreaking,
  isReleaseFile,
  majorJump,
  type ReleaseInput,
} from "../../src/ship/release.ts";
import { extraFilesOf } from "../../src/ship/releases.ts";

const patch = (...lines: string[]) => `@@ -1,3 +1,3 @@\n${lines.join("\n")}`;
const input: ReleaseInput = {
  manual: false,
  files: [],
  extraFiles: [],
  body: "",
  stale: false,
  checks: { state: "green", names: [] },
};

test("ship: a release PR touching other files is held", () => {
  const d = decideRelease({ ...input, files: [{ name: "src/a.ts", patch: patch("+x") }] });
  expect(d).toMatchObject({ kind: "hold", reason: "files" });
  expect(
    isReleaseFile({ name: "package.json", patch: patch('-  "dependencies": {', '+  "x": "1.0.0"') }, []),
  ).toBe(false);
  expect(isReleaseFile({ name: "package.json", patch: null }, [])).toBe(false);
});

test("ship: go.mod is not a release file", () => {
  expect(isReleaseFile({ name: "go.mod", patch: patch("-go 1.21", "+go 1.22") }, [])).toBe(false);
  expect(isReleaseFile({ name: "version.txt", patch: patch("-1.2.0", "+1.3.0") }, [])).toBe(true);
});

test("ship: extra-files of the release config count as release files", () => {
  expect(
    extraFilesOf(
      JSON.stringify({
        "extra-files": ["a.txt", { path: "b.json" }],
        packages: { "pkg/x": { "extra-files": ["c.txt"] } },
      }),
    ),
  ).toEqual(["a.txt", "b.json", "pkg/x/c.txt"]);
  expect(isReleaseFile({ name: "a.txt", patch: patch("-v 1.2.0", "+v 1.3.0") }, ["a.txt"])).toBe(true);
  expect(isReleaseFile({ name: "a.txt", patch: patch("-v 1.2.0", "+v 1.3.0") }, [])).toBe(false);
});

test("ship: a major release is held for the owner", () => {
  const files = [
    { name: ".release-please-manifest.json", patch: patch('-  ".": "1.9.0"', '+  ".": "2.0.0"') },
  ];
  expect(majorJump(files)).toBe("1.9.0 → 2.0.0");
  expect(
    majorJump([
      { name: ".release-please-manifest.json", patch: patch('-  ".": "1.9.0"', '+  ".": "1.10.0"') },
    ]),
  ).toBeNull();
});

test("ship: a breaking change in the release notes is held", () => {
  expect(isBreaking("### ⚠ BREAKING CHANGES\n\n* drop node 18", [])).toBe("drop node 18");
  expect(isBreaking("", [{ name: "CHANGELOG.md", patch: patch("+* feat!: new api") }])).toBe(
    "feat!: new api",
  );
  expect(isBreaking("### Features\n\n* a thing", [])).toBeNull();
});

test("ship: releases defaults to auto", () => {
  expect(decideRelease({ ...input, files: [{ name: "CHANGELOG.md", patch: patch("+x") }] })).toEqual({
    kind: "merge",
  });
});
