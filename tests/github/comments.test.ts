import { describe, expect, test } from "vitest";
import { stageComment, stageMarker, upsertStageComment } from "../../src/github/comments.ts";
import { prEvents } from "../../src/github/events.ts";
import { parsePr } from "../../src/github/prs.ts";
import { insertMission } from "../../src/mission.ts";
import { FakeTools, okResult } from "../helpers/tools.ts";
import { testDb } from "../helpers/world.ts";
import { BOT, fakeGitHub } from "./fakes.ts";

describe("stage comments", () => {
  test("github: stage comment has header and marker", () => {
    const text = stageComment("Review", 2, "Looks right.\n");
    const lines = text.split("\n");
    expect(lines[0]).toBe("<!-- towercab:review:2 -->");
    expect(lines[1]).toBe("**Review** · round 2");
    expect(text).toBe("<!-- towercab:review:2 -->\n**Review** · round 2\n\nLooks right.\n");
    expect(stageMarker("CI", 1)).toBe("<!-- towercab:ci:1 -->");
    // PIP-182: with an author, the header names the agent and the intent after the step.
    expect(stageComment("Review", 2, "ok", { agent: "reviewer", intent: "261001-0900" }).split("\n")[1]).toBe(
      "**Review** · reviewer · 261001-0900 · round 2",
    );

    // Towercab's own comment never causes an event, even with the owner's words in it.
    const db = testDb();
    const m = insertMission(db, { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 }, 0);
    db.run("UPDATE missions SET stage = 'approval:merge', pr = 7, head = 'h1' WHERE id = ?", m.id);
    const row = { ...m, stage: "approval:merge" as const, pr: 7, head: "h1" };
    const view = JSON.stringify({
      state: "OPEN",
      headRefOid: "h1",
      mergeable: "MERGEABLE",
      comments: [
        { id: "IC_1", author: { login: "towercab" }, createdAt: "2026-10-15T11:00:00Z", body: text },
      ],
      reviews: [],
    });
    expect(prEvents(row, { code: parsePr(view, "[]") }, "owner", BOT)).toBeNull();
  });

  test("github: same step edits its comment", async () => {
    let listed: unknown[] = [];
    const tools = new FakeTools().on("gh", (args) => {
      if (args[0] === "api" && args.includes("PATCH")) return okResult("{}");
      if (args[0] === "api") return okResult(JSON.stringify(listed));
      return okResult("https://github.com/me/web/pull/7#issuecomment-100\n");
    });
    const gh = fakeGitHub(tools);

    // First time: a new comment, the text through stdin.
    expect(await upsertStageComment(gh, "me/web", 7, "Verify", 1, "Checks pass.")).toEqual({ edited: false });
    expect(tools.lines("gh")).toEqual([
      "api --paginate repos/me/web/issues/7/comments?per_page=100",
      "pr comment 7 -R me/web --body-file -",
    ]);
    expect(tools.calls[1]!.opts.input).toBe(stageComment("Verify", 1, "Checks pass."));

    // The same step and round: the bot's comment is edited. The owner quoting the marker, or
    // another round, is left alone.
    listed = [
      { id: 100, user: { login: BOT }, body: stageComment("Verify", 1, "Checks pass.") },
      { id: 101, user: { login: "owner" }, body: "<!-- towercab:verify:2 -->\nquoted" },
      { id: 102, user: { login: BOT }, body: stageComment("Verify", 3, "Later.") },
    ];
    tools.calls.length = 0;
    expect(await upsertStageComment(gh, "me/web", 7, "Verify", 1, "Checks pass again.")).toEqual({
      edited: true,
    });
    expect(tools.lines("gh")[1]).toBe("api -X PATCH repos/me/web/issues/comments/100 --input -");
    expect(JSON.parse(tools.calls[1]!.opts.input!)).toEqual({
      body: stageComment("Verify", 1, "Checks pass again."),
    });
    tools.calls.length = 0;
    expect(await upsertStageComment(gh, "me/web", 7, "Verify", 2, "Round two.")).toEqual({ edited: false });
    expect(tools.lines("gh")[1]).toBe("pr comment 7 -R me/web --body-file -");
  });
});
