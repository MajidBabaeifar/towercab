import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { App, appJwt, loadKey } from "../../src/github/app.ts";
import { createGitHub, withoutTokens } from "../../src/github/gh.ts";
import { EnvError } from "../../src/handlers.ts";
import { FakeTools, okResult } from "../helpers/tools.ts";
import { git, TestClock, tempDir, testConfig, testDb } from "../helpers/world.ts";
import { BOT, BOT_EMAIL, FakeApi, verifyJwt, writeKey } from "./fakes.ts";

function setup() {
  const dir = tempDir();
  const keyPath = join(dir, "app.pem");
  const pub = writeKey(keyPath);
  const clock = new TestClock();
  const api = new FakeApi({ "me/a": 11, "me/b": 12, "me/web": 13 }, clock);
  const db = testDb();
  const config = testConfig({ github: { app_id: 77, me: "me", api_base: api.base } });
  const tools = new FakeTools();
  const github = createGitHub({ config, tools, db, keyPath, http: api.http, clock });
  return { dir, keyPath, pub, clock, api, db, config, tools, github };
}

/** A real script standing in for gh: answers git's credential protocol with GH_TOKEN. */
function credentialGh(dir: string): string {
  const path = join(dir, "gh");
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1 $2" = "auth git-credential" ]; then
  cat > /dev/null
  [ "$3" = get ] && printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n' "$GH_TOKEN"
  exit 0
fi
exit 1
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const cleanGitEnv = (home: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});

describe("github app", () => {
  test("github: installation token per repo", async () => {
    const { keyPath, pub, clock, api, tools, github, dir } = setup();

    // The JWT: RS256 with the App's key, iat now − 60 s, exp now + 540 s, iss the app id.
    const t = 1_800_000_000;
    expect(verifyJwt(appJwt(loadKey(keyPath), 77, t), pub)).toEqual({ iat: t - 60, exp: t + 540, iss: 77 });

    // One token per repo, passed as GH_TOKEN (the caller's GITHUB_TOKEN dropped).
    tools.on("gh", () => okResult("{}"));
    await github.gh("me/a", ["api", "x"], { env: { GITHUB_TOKEN: "mine", PATH: "/bin" } });
    await github.gh("me/b", ["api", "y"]);
    const [a, b] = api.tokens.map(([, tok]) => tok);
    expect(api.tokens).toEqual([
      [11, a],
      [12, b],
    ]);
    expect(api.calls()).toEqual([
      "GET /repos/me/a/installation",
      "POST /app/installations/11/access_tokens",
      "GET /repos/me/b/installation",
      "POST /app/installations/12/access_tokens",
    ]);
    const envs = tools.calls.map((c) => c.opts.env!);
    expect(envs[0]).toMatchObject({ GH_TOKEN: a, PATH: "/bin", GH_PROMPT_DISABLED: "1" });
    expect(envs[0]!.GITHUB_TOKEN).toBeUndefined();
    expect(envs[1]!.GH_TOKEN).toBe(b);
    expect(tools.calls[0]!.opts.timeoutMs).toBe(120_000);
    for (const r of api.requests) {
      expect(verifyJwt(r.headers.Authorization!.replace(/^Bearer /, ""), pub).iss).toBe(77);
      expect(r.headers.Accept).toBe("application/vnd.github+json");
    }
    expect(api.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body))).toEqual([
      { repositories: ["a"] },
      { repositories: ["b"] },
    ]);

    // Cached while 10 minutes or more remain (any case of owner/name); re-minted under that.
    clock.advance(49 * 60);
    await github.gh("ME/A", ["api", "z"]);
    expect(api.tokens).toHaveLength(2);
    clock.advance(2 * 60);
    await github.gh("me/a", ["api", "z"]);
    expect(api.tokens).toHaveLength(3);
    expect(tools.calls.at(-1)!.opts.env!.GH_TOKEN).toBe(api.tokens[2]![1]);
    expect(api.calls()).toHaveLength(5);
    expect(api.calls().at(-1)).toBe("POST /app/installations/11/access_tokens");

    // Reinstalled: the cached installation is refused, looked up again once.
    api.reinstall("me/a", 21);
    clock.advance(3600);
    await github.gh("me/a", ["api", "z"]);
    expect(api.tokens.at(-1)![0]).toBe(21);
    expect(api.calls().slice(5)).toEqual([
      "POST /app/installations/11/access_tokens",
      "GET /repos/me/a/installation",
      "POST /app/installations/21/access_tokens",
    ]);

    // Not installed: GitHub's no; down, unauthorized or unreachable: a github fault (LOOP-10).
    await expect(github.gh("me/c", ["api"])).rejects.toThrow(/^the GitHub App isn't installed on me\/c$/);
    for (const down of [502, 401, "net"] as const) {
      api.down = down;
      const e = await github.gh("me/web", ["api"]).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).fault).toBe("github");
    }
    api.down = null;

    // The key: PKCS#8 loads too; readable by others or not a key → refused, every call fails.
    const p8 = join(dir, "p8.pem");
    writeKey(p8, true);
    expect(loadKey(p8).asymmetricKeyType).toBe("rsa");
    chmodSync(p8, 0o644);
    expect(() => loadKey(p8)).toThrow(`${p8}: mode 644, want 600`);
    const junk = join(dir, "junk.pem");
    writeFileSync(junk, "not a key", { mode: 0o600 });
    expect(() => loadKey(junk)).toThrow(`${junk}: not an RSA private key (PKCS#1 or PKCS#8 PEM)`);
    const before = api.requests.length;
    const bad = new App({ appId: 77, apiBase: api.base, keyPath: p8, http: api.http, clock });
    await expect(bad.token("me/a")).rejects.toThrow(`${p8}: mode 644, want 600`);
    expect(api.requests.length).toBe(before);
  });

  test("github: git uses the App token", async () => {
    const { tools, github, api, dir } = setup();
    const gh = credentialGh(dir);
    tools.which = (cmd) => (cmd === "gh" ? gh : null);

    // What git gets: the owner's helpers dropped, gh's helper with GH_TOKEN, the bot as author.
    const auth = await github.gitAuth("me/a");
    const token = api.tokens[0]![1];
    expect(auth).toEqual({
      args: [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=!'${gh}' auth git-credential`,
        "-c",
        `user.name=${BOT}`,
        "-c",
        `user.email=${BOT_EMAIL}`,
      ],
      env: { GH_TOKEN: token },
    });

    // git asks the helper and gets the token (git ignores GH_TOKEN itself); a helper of the
    // owner's in the global config is not asked.
    const home = tempDir();
    writeFileSync(join(home, ".gitconfig"), "[credential]\n\thelper = !echo password=owner-secret; :\n");
    const filled = execFileSync("git", [...auth.args, "credential", "fill"], {
      input: "protocol=https\nhost=github.com\npath=me/a.git\n\n",
      env: { ...cleanGitEnv(home), ...auth.env },
      encoding: "utf8",
    });
    expect(filled).toContain(`password=${token}\n`);
    expect(filled).not.toContain("owner-secret");
  });

  test("github: commits are authored by the bot", async () => {
    const { github, api, db, config, tools, keyPath, clock } = setup();
    const repo = tempDir();
    git(repo, "init", "-q", "-b", "main");
    const auth = await github.gitAuth("me/a");
    const home = tempDir();
    execFileSync("git", [...auth.args, "commit", "-q", "--allow-empty", "-m", "x"], {
      cwd: repo,
      env: { ...cleanGitEnv(home), ...auth.env },
    });
    const who = git(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>").trim();
    expect(who).toBe(`${BOT} <${BOT_EMAIL}>|${BOT} <${BOT_EMAIL}>`);
    expect(await github.bot()).toEqual({ login: BOT, id: 42, email: BOT_EMAIL });

    // Kept in meta.bot: a new GitHub on the same database doesn't look it up again.
    expect(db.meta("bot")).toBe("towercab 42");
    const lookups = () => api.requests.filter((r) => r.path === "/app").length;
    expect(lookups()).toBe(1);
    const again = createGitHub({ config, tools, db, keyPath, http: api.http, clock });
    expect((await again.bot()).email).toBe(BOT_EMAIL);
    expect(lookups()).toBe(1);
    // The users lookup goes without the JWT.
    expect(api.requests.find((r) => r.path.startsWith("/users/"))!.headers.Authorization).toBeUndefined();
  });

  test("github: no token in Claude's environment", async () => {
    const { github, tools, api } = setup();
    tools.on("gh", () => okResult(""));
    const before = JSON.stringify(process.env);
    await github.gh("me/a", ["api", "x"]);
    const auth = await github.gitAuth("me/a");
    const token = api.tokens[0]![1];
    // The token lives only in the env of the gh and git calls it was made for.
    expect(auth.env.GH_TOKEN).toBe(token);
    expect(JSON.stringify(process.env)).toBe(before);
    expect(JSON.stringify(process.env)).not.toContain(token);
    // Env for Claude runs and the owner's gh: every GitHub token dropped.
    const env = { PATH: "/bin", GH_TOKEN: token, GITHUB_TOKEN: "t2", GH_ENTERPRISE_TOKEN: "t3", HOME: "/h" };
    expect(withoutTokens(env)).toEqual({ PATH: "/bin", HOME: "/h" });
    await github.owner(["pr", "view", "1"], { env });
    const ownerEnv = tools.calls.at(-1)!.opts.env!;
    expect(JSON.stringify(ownerEnv)).not.toContain(token);
    expect(ownerEnv.GITHUB_TOKEN).toBeUndefined();
  });

  test("github: the App manifest has LOOP-19's permissions", () => {
    const m = JSON.parse(readFileSync(join(import.meta.dirname, "../../ops/github-app.json"), "utf8"));
    expect(m.public).toBe(false);
    expect(m.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "write",
      statuses: "write",
      workflows: "write",
      actions: "write",
      metadata: "read",
    });
  });
});
