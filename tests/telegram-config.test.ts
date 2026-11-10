import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

test("config: telegram ui_url is optional", () => {
  const base = { bot_token: "t", chat_id: 42 };
  expect(parseConfig({ telegram: base }, "f").telegram).toEqual({
    botToken: "t",
    chatId: "42",
    apiBase: "https://api.telegram.org",
  });
  expect(parseConfig({ telegram: { ...base, ui_url: "https://tc.example" } }, "f").telegram?.uiUrl).toMatch(
    /^https:\/\/tc\.example/,
  );
});
