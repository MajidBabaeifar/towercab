// `[gitlab]` (GL-1): defaults, the api_base rule and the token file.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfig, parseConfig } from "../../src/config.ts";
import { tempDir } from "../helpers/world.ts";

const base = { intents: { remote: "/x.git" }, github: { app_id: 1, me: "owner" } };

function toml(token: string, mode: number, extra = ""): string {
  const dir = tempDir("tc-glcfg-");
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, token);
  chmodSync(tokenFile, mode);
  const file = join(dir, "config.toml");
  writeFileSync(
    file,
    `[intents]\nremote = "/x.git"\n[gitlab]\nme = "owner"\ntoken_file = "${tokenFile}"\n${extra}`,
  );
  return file;
}

test("gitlab: config defaults", () => {
  expect(parseConfig(base, "c.toml").gitlab).toBeNull();
  const c = parseConfig({ ...base, gitlab: { me: "boss", token_file: "/tmp/tok" } }, "c.toml");
  expect(c.gitlab).toEqual({ apiBase: "https://gitlab.com/api/v4", me: "boss", tokenFile: "/tmp/tok" });
  const own = parseConfig(
    { ...base, gitlab: { me: "boss", token_file: "/tmp/tok", api_base: "https://git.example.com/api/v4/" } },
    "c.toml",
  );
  expect(own.gitlab?.apiBase).toBe("https://git.example.com/api/v4");
  expect(loadConfig(toml("glpat-x\n", 0o600)).gitlab?.me).toBe("owner");
});

test("gitlab: config rejects a bad api_base", () => {
  const bad = (api_base: string) =>
    parseConfig({ ...base, gitlab: { me: "boss", token_file: "/tmp/tok", api_base } }, "c.toml");
  const msg = "config: c.toml: gitlab.api_base must be an https URL ending in /api/v4";
  expect(() => bad("http://git.example.com/api/v4")).toThrow(msg);
  expect(() => bad("https://git.example.com")).toThrow(msg);
  expect(() => bad("https://git.example.com/api/v3")).toThrow(msg);
  expect(bad("http://127.0.0.1:8080/api/v4").gitlab?.apiBase).toBe("http://127.0.0.1:8080/api/v4");
});

test("gitlab: config refuses a token file others can read", () => {
  expect(() => loadConfig(toml("glpat-x\n", 0o644))).toThrow(
    /gitlab\.token_file is readable by group or others/,
  );
  expect(() => loadConfig(toml("\n", 0o600))).toThrow(/gitlab\.token_file is empty/);
  const file = toml("glpat-x\n", 0o600);
  writeFileSync(file, `[intents]\nremote = "/x.git"\n[gitlab]\nme = "o"\ntoken_file = "/nonexistent/tok"\n`);
  expect(() => loadConfig(file)).toThrow(/gitlab\.token_file does not exist/);
});
