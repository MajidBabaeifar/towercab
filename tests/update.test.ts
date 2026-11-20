import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkUpdate, version } from "../src/update.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir } from "./helpers/world.ts";

function installed() {
  const bare = bareRepo({ "bin/towercab": "#!/bin/sh\n", "src/a.ts": "1\n" });
  const checkout = join(tempDir(), "towercab");
  git(tempDir(), "clone", "-q", bare, checkout);
  return { bare, checkout };
}

function tools(checkout: string, doctorOk = true): FakeTools {
  return new FakeTools()
    .on("npm", () => okResult())
    .on(join(checkout, "bin", "towercab"), () => (doctorOk ? okResult("ok") : failResult("config: missing")));
}

test("update: pulls and restarts when idle", async () => {
  const { bare, checkout } = installed();
  pushFiles(bare, { "src/a.ts": "2\n", "package-lock.json": "{}\n" });
  const t = tools(checkout);
  expect((await checkUpdate({ tools: t, checkout, idle: () => false })).kind).toBe("waiting");
  const r = await checkUpdate({ tools: t, checkout, idle: () => true });
  expect(r.kind).toBe("updated");
  expect(t.lines("npm")).toEqual(["ci --no-audit --no-fund", "run build:ui"]);
  expect(t.lines(join(checkout, "bin", "towercab"))).toEqual(["doctor --quick --for-update"]);
  expect((await version({ tools: t, checkout })).behind).toBe(0);
  expect((await checkUpdate({ tools: t, checkout, idle: () => true })).kind).toBe("none");
});

test("update: a failed check rolls back", async () => {
  const { bare, checkout } = installed();
  const before = git(checkout, "rev-parse", "HEAD").trim();
  pushFiles(bare, { "src/a.ts": "broken\n" });
  const r = await checkUpdate({ tools: tools(checkout, false), checkout, idle: () => true });
  expect(r).toMatchObject({ kind: "failed" });
  expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(before);
});

test("update: a loose secrets file only warns", async () => {
  const { bare, checkout } = installed();
  pushFiles(bare, { "src/a.ts": "2\n" });
  // The check's own output: a warning line and exit 0 (LOOP-145).
  const t = new FakeTools()
    .on("npm", () => okResult())
    .on(join(checkout, "bin", "towercab"), () =>
      okResult(
        "warning: /home/me/.config/towercab/app.pem is readable by others: chmod 600 /home/me/.config/towercab/app.pem",
      ),
    );
  expect((await checkUpdate({ tools: t, checkout, idle: () => true })).kind).toBe("updated");
  expect(t.lines(join(checkout, "bin", "towercab"))).toEqual(["doctor --quick --for-update"]);
});

test("update: another doctor failure still rolls back", async () => {
  const { bare, checkout } = installed();
  const before = git(checkout, "rev-parse", "HEAD").trim();
  pushFiles(bare, { "src/a.ts": "2\n" });
  const t = new FakeTools()
    .on("npm", () => okResult())
    .on(join(checkout, "bin", "towercab"), () => failResult("git: missing"));
  const r = await checkUpdate({ tools: t, checkout, idle: () => true });
  expect(r).toMatchObject({ kind: "failed" });
  expect(git(checkout, "rev-parse", "HEAD").trim()).toBe(before);
});

test("update: a dirty checkout is left alone", async () => {
  const { bare, checkout } = installed();
  pushFiles(bare, { "src/a.ts": "2\n" });
  writeFileSync(join(checkout, "src/a.ts"), "my edit\n");
  expect(await checkUpdate({ tools: tools(checkout), checkout, idle: () => true })).toMatchObject({
    kind: "none",
    why: "the checkout has local changes",
  });
  git(checkout, "checkout", "-q", "src/a.ts");
  git(checkout, "checkout", "-q", "-b", "feature");
  expect(await checkUpdate({ tools: tools(checkout), checkout, idle: () => true })).toMatchObject({
    kind: "none",
    why: "the checkout is on feature, not main",
  });
});
