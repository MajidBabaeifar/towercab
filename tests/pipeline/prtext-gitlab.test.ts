// INT-67: the code merge request closes a same-project GitLab issue and only names another project's.

import { expect, test } from "vitest";
import { issueLine } from "../../src/pipeline/prtext.ts";

const repo = "gitlab:group/sub/proj";

test("prtext: a same-project GitLab issue gets Closes", () => {
  expect(issueLine({ url: "https://gitlab.com/group/sub/proj/-/issues/7", repo })).toBe("Closes #7");
  // Project paths are case-insensitive, and a self-hosted GitLab works the same.
  expect(issueLine({ url: "https://git.example.org/Group/Sub/Proj/-/issues/7", repo })).toBe("Closes #7");
});

test("prtext: another project's GitLab issue is linked by full reference", () => {
  const line = issueLine({ url: "https://gitlab.com/group/other/-/issues/3", repo });
  expect(line).toBe("From the issue: group/other#3");
  expect(line).not.toMatch(/Closes|Fixes|Resolves/i);
  // A project that only shares a prefix is another project.
  expect(issueLine({ url: "https://gitlab.com/group/sub/proj2/-/issues/3", repo })).toBe(
    "From the issue: group/sub/proj2#3",
  );
});
