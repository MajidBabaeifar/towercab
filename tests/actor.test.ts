import { expect, test } from "vitest";
import { actorLabel, currentActor, ownerActor, runAs } from "../src/actor.ts";

test("users: an action records its actor and channel", async () => {
  const ana = { login: "ana", name: "Ana", role: "maintainer" as const, via: "page" as const };
  const seen = await runAs(ana, async () => {
    await Promise.resolve();
    return currentActor();
  });
  expect(seen).toEqual(ana);
  expect(actorLabel(seen)).toBe("Ana · page");
  expect(ownerActor("owner").via).toBe("cli");
});

test("users: an action by towercab is recorded as towercab", () => {
  expect(currentActor().login).toBe("towercab");
  expect(actorLabel(currentActor())).toBe("Towercab");
});
