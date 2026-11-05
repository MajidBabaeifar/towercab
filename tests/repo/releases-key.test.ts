// SHIP-31: the `releases` key of TOWERCAB.md.

import { expect, test } from "vitest";
import { defaultTowercab, parseTowercab } from "../../src/repo/files.ts";

test("ship: releases defaults to auto", () => {
  expect(parseTowercab("---\nmax_autonomy: 4\n---\n").releases).toBeUndefined();
  expect(parseTowercab("---\nreleases: auto\n---\n")).toEqual(defaultTowercab());
  expect(parseTowercab("---\nreleases: manual\n---\n").releases).toBe("manual");
  expect(() => parseTowercab("---\nreleases: sometimes\n---\n")).toThrow("releases must be auto or manual");
});
