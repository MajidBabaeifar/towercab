// REPO-45: the verifying section is also read from AGENTS.md when CLAUDE.md has none.

import { join } from "node:path";
import { expect, test } from "vitest";
import { loadRepoFiles, parseRepoFiles, RepoError } from "../../src/repo/files.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, tempDir } from "../helpers/world.ts";

const section = (cmd: string) => `# Repo\n\n## Verifying your work\n\n\`\`\`checks\n${cmd}\n\`\`\`\n`;

test("repo: verifying section read from AGENTS.md", async () => {
  expect(parseRepoFiles(null, null, null, "", section("make agents")).verifying.checks).toEqual([
    "make agents",
  ]);
  expect(parseRepoFiles("# no section\n", null, null, "", section("make agents")).verifying.checks).toEqual([
    "make agents",
  ]);
  // From the base branch, as the repo's files are.
  const bare = bareRepo({ "AGENTS.md": section("make agents"), "CLAUDE.md": "# prose only\n" });
  const clone = join(tempDir("tc-clone-"), "clone");
  git(join(clone, ".."), "clone", "-q", bare, clone);
  const files = await loadRepoFiles(new FakeTools(), clone, "main");
  expect(files.verifying.checks).toEqual(["make agents"]);
  // Neither has checks: the usual wait.
  expect(() => parseRepoFiles("# a\n", null, null, "", "# b\n")).toThrow(RepoError);
  // A broken AGENTS.md says so by name.
  const twice = `${section("x")}\n\`\`\`checks\ny\n\`\`\`\n`;
  expect(() => parseRepoFiles(null, null, null, "", twice)).toThrow(/^AGENTS.md: /);
});

test("repo: CLAUDE.md verifying wins over AGENTS.md", () => {
  const f = parseRepoFiles(section("make claude"), null, null, "", section("make agents"));
  expect(f.verifying.checks).toEqual(["make claude"]);
  // The two are never mixed block by block.
  const withSetup = parseRepoFiles(
    section("make claude"),
    null,
    null,
    "",
    "## Verifying your work\n\n```setup\nnpm ci\n```\n\n```checks\nmake agents\n```\n",
  );
  expect(withSetup.verifying.setup).toEqual([]);
});
