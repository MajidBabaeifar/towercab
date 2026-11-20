// LOOP-76, TG-4: a drop that would close an open PR with commits says so, then asks Yes or Cancel.

import { expect, test } from "vitest";
import { closeConfirmText } from "../src/telegram/render.ts";
import { ChatRig } from "./helpers/telegram.ts";

test("telegram: an exit that closes an open PR asks Yes or Cancel", async () => {
  const rig = new ChatRig();
  rig.wait("i-1");
  await rig.run();
  const msg = rig.sent()[0]!;
  // The page's actions know the open PR; the fake ones of the rig get the same answer.
  (rig.chat as unknown as { d: { actions: { closeWarning?: unknown } } }).d.actions.closeWarning =
    async () => ({
      pr: 12,
      commits: 3,
      text: "This closes PR #12 (3 commits) and deletes its branch. Nothing is merged.",
    });
  rig.press(rig.data(msg, "Drop"), 100);
  await rig.run();
  const e = rig.edits()[0]!;
  expect(e.text).toBe(
    "This closes PR #12 (3 commits) and deletes its branch. Nothing is merged.\nClose PR #12 with 3 commits?",
  );
  const keys = (e.keyboard as { text: string; callback_data: string }[][]).flat();
  expect(keys.map((b) => b.text)).toEqual(["Yes, drop", "Cancel"]);
  // Nothing happens until Yes; Cancel restores the card.
  expect(rig.actionCalls.filter((c) => c.startsWith("drop"))).toEqual([]);
  rig.press(keys[0]!.callback_data, 100);
  await rig.run();
  expect(rig.actionCalls.filter((c) => c.startsWith("drop"))).toEqual(["drop i-1"]);
});

test("telegram: the confirm of an unreadable PR is general", () => {
  const text = closeConfirmText({
    pr: 12,
    commits: null,
    text: "Couldn't check the PR; it may have commits. It will be closed and its branch deleted.",
  });
  expect(text).toBe(
    "Couldn't check the PR; it may have commits. It will be closed and its branch deleted.\nClose PR #12? It may have commits.",
  );
  expect(closeConfirmText({ pr: 7, commits: 1, text: "x" }).endsWith("Close PR #7 with 1 commit?")).toBe(
    true,
  );
});
