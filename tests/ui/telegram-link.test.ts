import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startUi, type UiServer } from "../../src/ui/server.ts";
import { buildFixture } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { call } from "./http.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

test("ui: the card opens for an intent in the address", async () => {
  const d = tempDir("tc-dist-");
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), "<!doctype html><title>Towercab</title>");
  const f = buildFixture();
  const ui: UiServer = startUi({
    port: 0,
    sources: f.sources,
    actions: null,
    distDir: d,
    log: () => {},
    pollMs: 20,
  });
  cleanup.push(
    () => f.cleanup(),
    () => ui.stop(),
  );
  const port = await ui.ready;
  const r = await call(port, { path: "/?intent=261025-0910-1" });
  expect(r.status).toBe(302);
  expect(r.headers.location).toBe("/inbox/261025-0910-1");
  expect((await call(port, { path: "/?intent=../etc" })).status).toBe(200);
  expect((await call(port, { path: "/" })).status).toBe(200);
});
