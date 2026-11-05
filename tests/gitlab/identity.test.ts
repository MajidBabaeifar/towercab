// The token is Towercab's identity and what git pushes with (GL-2).

import { expect, test } from "vitest";
import { GitLabForge, TOKEN_ENV } from "../../src/forge/gitlab.ts";
import { withoutTokens } from "../../src/github/gh.ts";
import { realTools } from "../../src/tools.ts";
import { FakeGitLab, GL_TOKEN, gitlabConfig } from "../helpers/gitlab.ts";

function forge() {
  const gl = new FakeGitLab();
  return { gl, forge: new GitLabForge(gitlabConfig().cfg, gl.http) };
}

test("gitlab: the token's bot user is the identity", async () => {
  const { gl, forge: f } = forge();
  expect(await f.bot()).toEqual({
    login: "towercab-bot",
    id: 77,
    name: "Towercab",
    email: "77-towercab-bot@noreply.gitlab.test",
  });
  await f.bot();
  expect(gl.calls()).toEqual(["GET /user"]);
  expect(gl.requests[0]!.token).toBe(GL_TOKEN);
});

test("gitlab: git uses the token through a credential helper", async () => {
  const { forge: f } = forge();
  const auth = await f.gitAuth();
  expect(auth.args.join(" ")).not.toContain(GL_TOKEN);
  const tools = realTools();
  const ask = (host: string) =>
    tools.run("git", [...auth.args, "credential", "fill"], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, ...auth.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  const mine = await ask("gitlab.test");
  expect(mine.stdout).toContain("username=oauth2");
  expect(mine.stdout).toContain(`password=${GL_TOKEN}`);
  // Only for the host of api_base.
  const other = await ask("evil.test");
  expect(other.stdout).not.toContain(GL_TOKEN);
});

test("gitlab: commits are authored by the bot", async () => {
  const { forge: f } = forge();
  const args = (await f.gitAuth()).args;
  expect(args).toContain("user.name=Towercab");
  expect(args).toContain("user.email=77-towercab-bot@noreply.gitlab.test");
});

test("gitlab: no token in Claude's environment", async () => {
  const { forge: f } = forge();
  expect((await f.gitAuth()).env).toEqual({ [TOKEN_ENV]: GL_TOKEN });
  const env = withoutTokens({ PATH: "/bin", [TOKEN_ENV]: GL_TOKEN, GITLAB_TOKEN: GL_TOKEN });
  expect(env).toEqual({ PATH: "/bin" });
});
