// The Overview's Problems name a secrets file others can read (UI-277).

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { secretsProblems } from "../src/ui/wire.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

function config(mode: number) {
  const dir = tempDir("tc-ui-secrets-");
  const key = join(dir, "app.pem");
  writeFileSync(key, "key");
  chmodSync(key, mode);
  return { key, config: testConfig({}, join(dir, "config.toml")) };
}

test("ui: problems show a loose secrets file with its chmod", () => {
  const { key, config: c } = config(0o644);
  const rows = secretsProblems(c);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ title: `${key} is readable by others`, fix: `Run chmod 600 ${key}` });
});

test("ui: no loose secrets file shows no row", () => {
  expect(secretsProblems(config(0o600).config)).toEqual([]);
});
