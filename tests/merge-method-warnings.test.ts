// The warnings of `repo add` and `doctor` about a merge method (LOOP-155).

import { expect, test } from "vitest";
import type { RepoConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { doctor } from "../src/doctor.ts";
import type { MergeMethod } from "../src/forge.ts";
import type { GitHub } from "../src/handlers.ts";
import { Home } from "../src/home.ts";
import { mergeMethodWarnings, readMergeWarnings } from "../src/merge-method.ts";
import { loadRepos, setRepo } from "../src/repos.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

const T0 = 1_793_000_000;

const repo = (mergeMethod?: RepoConfig["mergeMethod"]): RepoConfig => ({
  name: "web",
  github: "owner/web",
  path: "",
  base: "main",
  workers: 1,
  ahead: 3,
  env: {},
  ...(mergeMethod ? { mergeMethod } : {}),
});

const forgeAllowing = (allowed?: MergeMethod[]) => {
  const f = new FakeForge();
  if (allowed) f.allowedMethods.set("owner/web", allowed);
  return f;
};

test("cli: repo add warns when squash is not allowed", async () => {
  const out = await readMergeWarnings(forgeAllowing(["merge"]), repo());
  expect(out).toEqual([
    "warning: owner/web does not allow squash merges (allowed: merge): run towercab repo set web merge_method=auto",
  ]);
});

test("cli: repo add is quiet when the method is allowed", async () => {
  expect(await readMergeWarnings(forgeAllowing(["squash", "merge"]), repo())).toEqual([]);
  // Settings that can't be read, and GitLab repos, print nothing.
  expect(await readMergeWarnings(forgeAllowing(), repo())).toEqual([]);
  expect(await readMergeWarnings(forgeAllowing(["merge"]), { ...repo(), github: "gitlab:g/p" })).toEqual([]);
});

test("cli: repo add names auto as the fix", async () => {
  const out = await readMergeWarnings(forgeAllowing(["rebase"]), repo());
  expect(out[0]).toMatch(/merge_method=auto$/);
  // Not allowed with `merge` set by hand: the same fix.
  expect((await readMergeWarnings(forgeAllowing(["squash"]), repo("merge")))[0]).toMatch(
    /merge_method=auto$/,
  );
});

test("cli: repo add warns about rebase", async () => {
  expect(await readMergeWarnings(forgeAllowing(["rebase"]), repo("auto"))).toEqual([
    "warning: web merges by rebase: release notes rely on the repo's own commits following Conventional Commits",
  ]);
  expect(mergeMethodWarnings(repo("rebase"), ["rebase"])).toHaveLength(1);
});

function world() {
  const db = Db.memory();
  const config = testConfig({ github: { app_id: 1, me: "Owner" } });
  const home = new Home(tempDir("tc-home-"));
  loadRepos(config, db, T0);
  return { db, config, home };
}

/** A GitHub that answers the repo's merge settings, or fails them. */
function host(settings: { s: boolean; m: boolean; r: boolean } | "fail"): GitHub {
  return {
    owner: async () => okResult("Logged in to github.com account Owner"),
    gh: async (_repo: string, args: string[]) => {
      if (args[0] === "api" && args[1] === "repos/owner/web") {
        if (settings === "fail") return failResult("HTTP 403");
        return okResult(
          JSON.stringify({
            allow_squash_merge: settings.s,
            allow_merge_commit: settings.m,
            allow_rebase_merge: settings.r,
          }),
        );
      }
      return failResult("HTTP 404");
    },
  } as unknown as GitHub;
}

const lines = async (w: ReturnType<typeof world>, github: GitHub, quick = false) =>
  (await doctor({ config: w.config, home: w.home, tools: new FakeTools(), github, quick })).lines;

test("doctor: a method the repo forbids is a warning", async () => {
  const w = world();
  const out = await lines(w, host({ s: false, m: true, r: false }));
  expect(out).toContain(
    "warning: owner/web does not allow squash merges (allowed: merge): run towercab repo set web merge_method=auto",
  );
  // A warning: the exit code does not change, and allowing the method clears it.
  const res = await doctor({
    config: w.config,
    home: w.home,
    tools: new FakeTools(),
    github: host({ s: false, m: true, r: false }),
    quick: false,
  });
  const clean = await doctor({
    config: w.config,
    home: w.home,
    tools: new FakeTools(),
    github: host({ s: true, m: true, r: false }),
    quick: false,
  });
  expect(res.ok).toBe(clean.ok);
  expect((await lines(w, host({ s: true, m: true, r: false }))).some((l) => l.includes("merges"))).toBe(
    false,
  );
});

test("doctor: rebase warns about conventional commits", async () => {
  const w = world();
  setRepo(w.db, w.config, "web", ["merge_method=auto"]);
  expect(await lines(w, host({ s: false, m: false, r: true }))).toContain(
    "warning: web merges by rebase: release notes rely on the repo's own commits following Conventional Commits",
  );
});

test("doctor: unreadable merge settings are not a warning", async () => {
  const w = world();
  expect((await lines(w, host("fail"))).some((l) => l.includes("merge"))).toBe(false);
  // --quick never asks the host.
  expect(
    (await lines(w, host({ s: false, m: true, r: false }), true)).some((l) => l.includes("does not allow")),
  ).toBe(false);
});

test("doctor: auto with no allowed method is a warning", async () => {
  const w = world();
  setRepo(w.db, w.config, "web", ["merge_method=auto"]);
  expect(await lines(w, host({ s: false, m: false, r: false }))).toContain(
    "warning: owner/web allows no merge method: allow squash, merge or rebase merges in its settings",
  );
  // `auto` is otherwise never warned about.
  expect(
    (await lines(w, host({ s: false, m: true, r: false }))).some((l) => l.includes("does not allow")),
  ).toBe(false);
});
