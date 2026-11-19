// A repo's merge method (LOOP-153) and the merges made with it (LOOP-154).

import { describe, expect, test } from "vitest";
import type { RepoConfig } from "../src/config.ts";
import { MERGE_METHOD } from "../src/forge.ts";
import { GitHubForge } from "../src/github/forge.ts";
import { approve } from "../src/github/owner.ts";
import { autoMethod, mergeWithRepoMethod } from "../src/merge-method.ts";
import { authStatus, fakeGitHub } from "./github/fakes.ts";
import { FakeForge } from "./helpers/fake-forge.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";

function repo(mergeMethod?: RepoConfig["mergeMethod"], github = "o/web"): RepoConfig {
  return {
    name: "web",
    github,
    path: "",
    base: "main",
    workers: 1,
    ahead: 3,
    env: {},
    ...(mergeMethod ? { mergeMethod } : {}),
  };
}

const config = (r: RepoConfig) => ({ repos: new Map([[r.name, r]]) });

async function pr(f: FakeForge, github = "o/web"): Promise<number> {
  return (await f.openPr(github, { base: "main", head: "b", title: "feat(x): y", body: "" }))!;
}

const merges = (f: FakeForge) => f.calls.filter((c) => c.startsWith("merge "));

describe("merge", () => {
  test("merge: uses the repo's method", async () => {
    for (const method of ["squash", "merge", "rebase"] as const) {
      const f = new FakeForge();
      const n = await pr(f);
      expect((await mergeWithRepoMethod(f, config(repo(method)), "o/web", n)).ok).toBe(true);
      expect(merges(f)).toEqual([`merge o/web#${n} ${method}`]);
    }
    // No setting, a repo Towercab doesn't know (the intents repo) and a GitLab repo all squash.
    const f = new FakeForge();
    const n = await pr(f);
    await mergeWithRepoMethod(f, config(repo()), "o/web", n, { head: "sha-1" });
    const other = await pr(f, "o/intents");
    await mergeWithRepoMethod(f, config(repo("rebase")), "o/intents", other);
    const gl = await pr(f, "gitlab:g/p");
    await mergeWithRepoMethod(f, config(repo("merge", "gitlab:g/p")), "gitlab:g/p", gl);
    expect(merges(f)).toEqual([
      `merge o/web#${n} squash head=sha-1`,
      `merge o/intents#${other} ${MERGE_METHOD}`,
      `merge gitlab:g/p#${gl} ${MERGE_METHOD}`,
    ]);
  });

  test("merge: squash is made as before, with no title override", async () => {
    const tools = new FakeTools().on("gh", () => okResult());
    const forge = new GitHubForge(fakeGitHub(tools));
    await mergeWithRepoMethod(forge, config(repo("squash")), "o/web", 7, { head: "abc" });
    expect(tools.lines("gh")).toEqual(["pr merge 7 --squash --match-head-commit abc -R o/web"]);
  });

  test("merge: merge commit keeps the PR title as the subject", async () => {
    const tools = new FakeTools().on("gh", (args) =>
      args[1] === "view" ? okResult('{"title":"feat(x): y"}') : okResult(),
    );
    const forge = new GitHubForge(fakeGitHub(tools));
    await mergeWithRepoMethod(forge, config(repo("merge")), "o/web", 7);
    expect(tools.lines("gh")).toEqual([
      "pr view 7 -R o/web --json title",
      "pr merge 7 --merge --subject feat(x): y -R o/web",
    ]);
    // A title that can't be read doesn't stop the merge.
    const blind = new FakeTools().on("gh", (args) => (args[1] === "view" ? okResult("<html>") : okResult()));
    expect(
      (await mergeWithRepoMethod(new GitHubForge(fakeGitHub(blind)), config(repo("merge")), "o/web", 7)).ok,
    ).toBe(true);
    expect(blind.lines("gh")[1]).toBe("pr merge 7 --merge -R o/web");
  });

  test("merge: rebase sets no title", async () => {
    const tools = new FakeTools().on("gh", () => okResult());
    const forge = new GitHubForge(fakeGitHub(tools));
    await mergeWithRepoMethod(forge, config(repo("rebase")), "o/web", 7);
    expect(tools.lines("gh")).toEqual(["pr merge 7 --rebase -R o/web"]);
  });

  test("merge: a refused method names the setting to change", async () => {
    const f = new FakeForge();
    const n = await pr(f);
    f.mergePr = async () => ({ ok: false, reason: "Merge commits are not allowed on this repository." });
    expect(await mergeWithRepoMethod(f, config(repo("merge")), "o/web", n)).toEqual({
      ok: false,
      reason: "merge merges are not allowed on o/web: run towercab repo set web merge_method=auto",
    });
    // Any other refusal keeps the host's words, and nothing is retried with another method.
    f.mergePr = async () => ({ ok: false, reason: "Pull request is not mergeable" });
    expect((await mergeWithRepoMethod(f, config(repo("merge")), "o/web", n)).reason).toBe(
      "Pull request is not mergeable",
    );
  });

  test("merge: auto uses the method the repo allows", async () => {
    expect(autoMethod(["merge", "rebase"])).toBe("merge");
    expect(autoMethod(["squash", "merge"])).toBe("squash");
    expect(autoMethod(["rebase"])).toBe("rebase");
    expect(autoMethod([])).toBe("squash");
    expect(autoMethod(null)).toBe("squash");
    const f = new FakeForge();
    f.allowedMethods.set("o/web", ["merge", "rebase"]);
    const n = await pr(f);
    await mergeWithRepoMethod(f, config(repo("auto")), "o/web", n);
    expect(merges(f)).toEqual([`merge o/web#${n} merge`]);
    // Settings that can't be read: squash.
    const g = new FakeForge();
    const m = await pr(g);
    await mergeWithRepoMethod(g, config(repo("auto")), "o/web", m);
    expect(merges(g)).toEqual([`merge o/web#${m} squash`]);
  });
});

describe("owner", () => {
  test("owner: approve merges with the repo's method", async () => {
    const tools = new FakeTools().on("gh", (args) =>
      args[0] === "auth" ? okResult(authStatus("owner")) : okResult(""),
    );
    const gh = fakeGitHub(tools, "owner");
    await approve(gh, "me/web", 7, config(repo("rebase", "me/web")));
    expect(tools.lines("gh")).toEqual(["auth status --hostname github.com", "pr merge 7 --rebase -R me/web"]);
  });
});
