import { describe, expect, test } from "vitest";
import { answer, approve, closePr, ownerLogin, parseAuthStatus, reply } from "../../src/github/owner.ts";
import type { IntentEdit, IntentStore } from "../../src/intents/types.ts";
import { FakeTools, failResult, okResult } from "../helpers/tools.ts";
import { authStatus, fakeGitHub } from "./fakes.ts";

/** A store that records what `update` did. */
function fakeStore() {
  const answers: { id: string; what: string; text: string; at: Date }[] = [];
  const store = {
    async update(id: string, what: string, fn: (e: IntentEdit) => void) {
      fn({
        addAnswer: (text: string, at: Date) => answers.push({ id, what, text, at }),
      } as unknown as IntentEdit);
      return {} as never;
    },
  } as unknown as IntentStore;
  return { store, answers };
}

function ownerTools(login: string) {
  return new FakeTools().on("gh", (args) =>
    args[0] === "auth" ? okResult(authStatus(login)) : okResult(""),
  );
}

describe("owner", () => {
  test("owner: approve merges as the owner", async () => {
    const tools = ownerTools("Owner");
    const gh = fakeGitHub(tools, "owner");
    await approve(gh, "me/web", 7);
    expect(tools.lines("gh")).toEqual(["auth status --hostname github.com", "pr merge 7 -R me/web --squash"]);
    // Under the owner's login: no App token in any call.
    expect(tools.calls.every((c) => c.opts.env?.GH_TOKEN === undefined)).toBe(true);

    await reply(gh, "me/web", 7, "Use the other table.");
    await closePr(gh, "me/web", 7);
    expect(tools.lines("gh").filter((l) => !l.startsWith("auth"))).toEqual([
      "pr merge 7 -R me/web --squash",
      "pr comment 7 -R me/web --body-file -",
      "pr close 7 -R me/web",
    ]);
    expect(tools.calls.find((c) => c.args[1] === "comment")!.opts.input).toBe("Use the other table.");

    // gh logged in as someone else, or not at all: nothing is done.
    const other = ownerTools("someone");
    await expect(approve(fakeGitHub(other, "owner"), "me/web", 7)).rejects.toThrow(
      "gh is logged in as someone, not owner: gh auth switch -u owner",
    );
    expect(other.lines("gh")).toEqual(["auth status --hostname github.com"]);
    const none = new FakeTools().on("gh", () => failResult("You are not logged into any GitHub hosts."));
    await expect(ownerLogin(fakeGitHub(none, "owner"))).rejects.toThrow(/isn't logged in/);

    // A refused merge says why.
    const refused = new FakeTools().on("gh", (args) =>
      args[0] === "auth" ? okResult(authStatus("owner")) : failResult("Pull request is not mergeable"),
    );
    await expect(approve(fakeGitHub(refused), "me/web", 7)).rejects.toThrow(
      "gh pr merge: Pull request is not mergeable",
    );

    // gh auth status: the active account wins; older gh's wording too.
    expect(
      parseAuthStatus(
        "github.com\n  ✓ Logged in to github.com account a (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account b (keyring)\n  - Active account: true\n",
      ),
    ).toBe("b");
    expect(parseAuthStatus("github.com\n  ✓ Logged in to github.com as old (oauth_token)\n")).toBe("old");
  });

  test("owner: answer without a PR", async () => {
    const tools = ownerTools("owner");
    const gh = fakeGitHub(tools);
    const { store, answers } = fakeStore();
    const at = new Date("2026-10-15T12:00:00Z");

    // No PR yet: appended to the intent's ## Answers, nothing on GitHub; the caller continues it.
    expect(await answer({ gh, store }, "261001-0900", null, "  Use Postgres.  ", at)).toBe("intent");
    expect(answers).toEqual([{ id: "261001-0900", what: "answer", text: "Use Postgres.", at }]);
    expect(tools.calls).toEqual([]);

    // With a PR: a comment as the owner, which the next PR read takes as the answer.
    expect(
      await answer({ gh, store }, "261001-0900", { repo: "me/web", number: 7 }, "Use Postgres.", at),
    ).toBe("pr");
    expect(tools.lines("gh").at(-1)).toBe("pr comment 7 -R me/web --body-file -");
    expect(answers).toHaveLength(1);
    await expect(answer({ gh, store }, "261001-0900", null, " ", at)).rejects.toThrow("an answer needs text");
  });
});
