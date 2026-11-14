// `doctor --quick` never fails the self-update on a loose secrets file (LOOP-145), even when an older
// Towercab calls it without `--for-update`.

import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";

let out = "";
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out += String(s);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

function setup(): { config: string; home: string; key: string } {
  const intents = bareRepo({ "intents/.keep": "" });
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${intents}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  const key = join(dirname(config), "app.pem");
  writeFileSync(key, "key");
  chmodSync(key, 0o644);
  return { config, home: join(dir, "home"), key };
}

test("update: plain doctor --quick only warns about a loose secrets file", async () => {
  const { config, home, key } = setup();
  for (const extra of [[], ["--for-update"]]) {
    out = "";
    const code = await main(
      ["--config", config, "--home", home, "doctor", "--quick", ...extra],
      new FakeTools(),
    );
    expect(out).toContain(`warning: ${key} is readable by others: chmod 600 ${key}`);
    expect(code).toBe(0);
  }
});

test("update: the full doctor still fails on a loose secrets file", async () => {
  const { config, home, key } = setup();
  const code = await main(["--config", config, "--home", home, "doctor"], new FakeTools());
  expect(out).toContain(`secrets: ${key} is readable by others: chmod 600 ${key}`);
  expect(code).toBe(1);
});
