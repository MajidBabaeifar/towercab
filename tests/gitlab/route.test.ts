// Every call about a repo goes to the host the repo lives on (GL-13).

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { GitLabHost } from "../../src/forge/gitlab-host.ts";
import { REPO_LESS, routed } from "../../src/forge/route.ts";
import type { Forge } from "../../src/forge.ts";
import type { Host } from "../../src/handlers.ts";
import { FakeGitLab, gitlabConfig } from "../helpers/gitlab.ts";

/** A host that records the name of every method called on it, and answers nothing. */
function spy(who: string, seen: string[]): Host {
  return new Proxy(
    { me: who } as Host,
    {
      get: (_t: unknown, key: string | symbol) =>
        key === "me"
          ? who
          : key === "then"
            ? undefined
            : (..._a: unknown[]) => {
                seen.push(`${who}:${String(key)}`);
                return key === "asOwner" ? spy(`${who}-owner`, seen) : Promise.resolve(null);
              },
      has: () => true,
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => undefined,
      // biome-ignore lint/suspicious/noExplicitAny: the target is only a stand-in
    } as any,
  ) as Host;
}

/** The names of the `Forge` methods the GitLab implementation has. */
function methods(): string[] {
  const host = new GitLabHost(new GitLabForge(gitlabConfig().cfg, new FakeGitLab().http));
  return Object.getOwnPropertyNames(Object.getPrototypeOf(host)).filter(
    (k) => k !== "constructor" && typeof (host as unknown as Record<string, unknown>)[k] === "function",
  );
}

test("gitlab: every Forge method is routed by repo or listed as repo-less", () => {
  const names = methods();
  expect(names.length).toBeGreaterThan(40);
  const seen: string[] = [];
  const host = routed(spy("github", seen), spy("gitlab", seen) as unknown as Forge);
  const callable = host as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of names.filter((n) => !REPO_LESS.has(n) && n !== "bot")) {
    callable[name]!("gitlab:group/project", 1, 2);
    callable[name]!("owner/name", 1, 2);
  }
  for (const name of names.filter((n) => !REPO_LESS.has(n) && n !== "bot")) {
    expect(seen, name).toContain(`gitlab:${name}`);
    expect(seen, name).toContain(`github:${name}`);
  }
  // The repo-less ones are GitHub's, whatever they are asked.
  seen.length = 0;
  for (const name of REPO_LESS) if (name !== "asOwner") callable[name]!();
  expect(seen.every((s) => s.startsWith("github:"))).toBe(true);
});

test("gitlab: bot and identity follow the repo", async () => {
  const seen: string[] = [];
  const host = routed(spy("github", seen), spy("gitlab", seen) as unknown as Forge);
  await host.bot();
  await host.bot("gitlab:g/p");
  await host.bot("o/n");
  expect(seen).toEqual(["github:bot", "gitlab:bot", "github:bot"]);
  expect(host.identityOf("gitlab:g/p").me).toBe("gitlab");
  expect(host.identityOf("o/n").me).toBe("github");
  expect(host.me).toBe("github");
});

test("gitlab: acting as the owner is routed by repo too", async () => {
  const seen: string[] = [];
  const host = routed(spy("github", seen), spy("gitlab", seen) as unknown as Forge);
  const owner = host.asOwner() as unknown as Record<string, (...a: unknown[]) => unknown>;
  await owner.mergePr!("gitlab:g/p", 1, {});
  await owner.mergePr!("o/n", 1, {});
  expect(seen.filter((s) => s.endsWith("mergePr"))).toEqual(["gitlab-owner:mergePr", "github-owner:mergePr"]);
});
