import { expect, test } from "vitest";
import { parseConfig } from "../../src/config.ts";

const base = { intents: { remote: "r" }, github: { app_id: 1, me: "me" } };
const tg = { telegram: { bot_token: "t", chat_id: 42 } };

test("config: shadow settings load and bad values name the key", () => {
  expect(parseConfig(base, "f").shadow).toEqual({ enabled: false, free: [], dailyBudgetUsd: 5, model: null });
  const on = parseConfig(
    { ...base, ...tg, shadow: { enabled: true, free: ["drop"], daily_budget_usd: 2.5, model: "sonnet" } },
    "f",
  );
  expect(on.shadow).toEqual({ enabled: true, free: ["drop"], dailyBudgetUsd: 2.5, model: "sonnet" });
  const bad: [Record<string, unknown>, string][] = [
    [{ enabled: "yes" }, "shadow.enabled must be true or false"],
    [{ free: ["merge", "confirm"] }, "shadow.free: confirm is not one of merge, boost, drop"],
    [{ free: "merge" }, "shadow.free must be a list of non-empty strings"],
    [{ daily_budget_usd: 0 }, "shadow.daily_budget_usd must be a number above 0"],
    [{ model: "two words" }, "shadow.model must be a non-empty word"],
  ];
  for (const [shadow, why] of bad) {
    expect(() => parseConfig({ ...base, ...tg, shadow }, "f")).toThrow(`config: f: ${why}`);
  }
  expect(() => parseConfig({ ...base, shadow: { enabled: true } }, "f")).toThrow(
    "config: f: shadow.enabled needs a [telegram] section",
  );
});
