// LOOP-81's setting: how long a freeze may last before the owner is asked.

import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

test("config: freeze_wait is a setting in minutes", () => {
  const raw = (agent: Record<string, unknown>) => ({ intents: { remote: "r" }, agent });
  expect(parseConfig(raw({ freeze_wait: 45 }), "config.toml").agent.freezeWaitMin).toBe(45);
  expect(parseConfig(raw({ freeze_wait: 1 }), "config.toml").agent.freezeWaitMin).toBe(1);
  expect(parseConfig(raw({ freeze_wait: 1440 }), "config.toml").agent.freezeWaitMin).toBe(1440);
});
