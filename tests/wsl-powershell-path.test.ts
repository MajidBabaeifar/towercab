// A systemd service has no Windows directory on its PATH, so PowerShell is found by absolute path (LOOP-142).

import { expect, test } from "vitest";
import { POWERSHELL, POWERSHELL_FALLBACK, powershellPath } from "../src/wsl.ts";
import { FakeTools } from "./helpers/tools.ts";

test("awake: powershell is found under /mnt/c when PATH lacks it", () => {
  const t = new FakeTools();
  expect(powershellPath(t, () => true)).toBe(POWERSHELL_FALLBACK);
  expect(powershellPath(t, () => false)).toBeNull();
  t.present.add(POWERSHELL);
  expect(powershellPath(t, () => false)).toBe(POWERSHELL);
});
