// `repo set merge_method=…` (LOOP-153).

import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { Home } from "../src/home.ts";
import { loadRepos, readRepos, repoList, setRepo, setRepoChecked } from "../src/repos.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

const T0 = 1_793_000_000;

function world() {
  const db = Db.memory();
  const config = testConfig({ github: { app_id: 1, me: "Owner" } });
  const home = new Home(tempDir("tc-home-"));
  loadRepos(config, db, T0);
  return { db, config, home };
}

test("repos: set merge_method", async () => {
  const w = world();
  // Squash is the default, and a repo that never sets another carries none.
  expect(w.config.repos.get("web")).not.toHaveProperty("mergeMethod");
  expect(repoList(w.db, w.home.root)).not.toMatch(/merge:/);
  expect(setRepo(w.db, w.config, "web", ["merge_method=merge"]).mergeMethod).toBe("merge");
  expect(w.config.repos.get("web")?.mergeMethod).toBe("merge");
  expect(readRepos(w.db)[0]?.mergeMethod).toBe("merge");
  expect(w.db.get<{ merge_method: string }>("SELECT merge_method FROM repos")?.merge_method).toBe("merge");
  expect(setRepo(w.db, w.config, "web", ["merge_method=auto"]).mergeMethod).toBe("auto");
  // Back to squash drops it again.
  expect(setRepo(w.db, w.config, "web", ["merge_method=squash"])).not.toHaveProperty("mergeMethod");
  expect(w.db.get<{ merge_method: string }>("SELECT merge_method FROM repos")?.merge_method).toBe("squash");
});

test("repos: merge_method refuses an unknown value", () => {
  const w = world();
  expect(() => setRepo(w.db, w.config, "web", ["merge_method=fast-forward"])).toThrow(
    "merge_method must be squash, merge, rebase or auto",
  );
  // One bad pair changes nothing.
  expect(() => setRepo(w.db, w.config, "web", ["merge_method=merge", "workers=0"])).toThrow();
  expect(w.config.repos.get("web")).not.toHaveProperty("mergeMethod");
});

test("repos: merge_method auto takes the first allowed method", async () => {
  const w = world();
  setRepo(w.db, w.config, "web", ["merge_method=auto"]);
  expect(repoList(w.db, w.home.root)).toMatch(/ · merge: auto/);
  // The resolution itself is checked by `merge: auto uses the method the repo allows`.
  const f = new FakeForge();
  f.allowedMethods.set("owner/web", ["merge", "rebase"]);
  expect(await f.allowedMergeMethods("owner/web")).toEqual(["merge", "rebase"]);
});

test("repos: merge_method auto takes rebase only when nothing else is allowed", async () => {
  const { autoMethod } = await import("../src/merge-method.ts");
  expect(autoMethod(["rebase"])).toBe("rebase");
  expect(autoMethod(["merge", "rebase"])).toBe("merge");
});

test("repos: merge_method auto falls back to squash", async () => {
  const { autoMethod } = await import("../src/merge-method.ts");
  expect(autoMethod(null)).toBe("squash");
  expect(autoMethod([])).toBe("squash");
});

test("repos: merge_method rebase is refused when squash or merge is allowed", async () => {
  const w = world();
  const f = new FakeForge();
  for (const allowed of [
    ["squash", "rebase"],
    ["merge", "rebase"],
    ["squash", "merge", "rebase"],
    ["squash"],
    [],
  ] as const) {
    f.allowedMethods.set("owner/web", [...allowed]);
    await expect(setRepoChecked(w.db, w.config, f, "web", ["merge_method=rebase"])).rejects.toThrow(
      /^merge_method: rebase is only for repos that allow nothing else \(.*\): use squash, merge or auto$/,
    );
  }
  expect(w.config.repos.get("web")).not.toHaveProperty("mergeMethod");
  // Allowed when rebase is the only method.
  f.allowedMethods.set("owner/web", ["rebase"]);
  expect((await setRepoChecked(w.db, w.config, f, "web", ["merge_method=rebase"])).mergeMethod).toBe(
    "rebase",
  );
});

test("repos: merge_method rebase is refused when the settings can't be read", async () => {
  const w = world();
  const unreadable = new FakeForge();
  await expect(setRepoChecked(w.db, w.config, unreadable, "web", ["merge_method=rebase"])).rejects.toThrow(
    "merge_method: can't read owner/web's merge settings to check that rebase is the only method allowed",
  );
  await expect(setRepoChecked(w.db, w.config, null, "web", ["merge_method=rebase"])).rejects.toThrow(
    "can't read owner/web's merge settings",
  );
  // The other methods never ask the host.
  expect((await setRepoChecked(w.db, w.config, unreadable, "web", ["merge_method=merge"])).mergeMethod).toBe(
    "merge",
  );
  expect(unreadable.calls.filter((c) => c.startsWith("allowed-merge-methods"))).toHaveLength(1);
});

test("repos: merge_method is refused on a GitLab repo", () => {
  const w = world();
  w.db.run(
    "INSERT INTO repos (name, github, base, source, added) VALUES (?, ?, ?, ?, ?)",
    "api",
    "gitlab:g/api",
    "main",
    "cli",
    T0,
  );
  expect(() => setRepo(w.db, w.config, "api", ["merge_method=merge"])).toThrow(
    "merge_method is only for GitHub repos",
  );
});

test("cli: repo list shows a merge method other than squash", () => {
  const w = world();
  setRepo(w.db, w.config, "web", ["merge_method=merge"]);
  expect(repoList(w.db, w.home.root)).toMatch(/ · merge: merge$/);
  setRepo(w.db, w.config, "web", ["merge_method=squash"]);
  expect(repoList(w.db, w.home.root)).not.toMatch(/merge:/);
});
