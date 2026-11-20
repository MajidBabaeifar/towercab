// An agent's reply is read for its words: the marker and first line before them are skipped (PIP-184).

import { expect, test } from "vitest";
import { stripAgentHeader } from "../../src/github/agent-header.ts";
import { agentReplyBody } from "../../src/github/owner.ts";
import { parseAllow, readReply } from "../../src/pipeline/access.ts";

const ASKED = ["tests/a.test.ts", "tests/b.test.ts"];

test("pipeline: an agent reply is read for its answer", () => {
  const marked = agentReplyBody("claude-code", "Majid", "Allow both.");
  expect(stripAgentHeader(marked)).toBe("Allow both.");
  expect(readReply(marked, ASKED).allowed).toEqual(ASKED);
  expect(readReply(agentReplyBody("claude-code", "Majid", "No, keep them."), ASKED).refused).toEqual(ASKED);
  // The older bracketed first line too.
  const bracket = "[answered by a Claude Code session acting for the owner]\n\nAllow both.";
  expect(readReply(bracket, ASKED).allowed).toEqual(ASKED);
  expect(parseAllow(agentReplyBody("x", "Majid", "allow tests/a.test.ts"))).toEqual(["tests/a.test.ts"]);
  // Words with no answer in them still decide nothing, and plain text is left as it is.
  expect(readReply(agentReplyBody("x", "Majid", "Looking into it."), ASKED).undecided).toEqual(ASKED);
  expect(stripAgentHeader("yes, allow")).toBe("yes, allow");
});
