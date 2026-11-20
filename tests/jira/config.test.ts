// JIRA-1, JIRA-3: the `[jira]` table and `[jira.repos]`.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadConfig, parseConfig } from "../../src/config.ts";
import { Pipe } from "../helpers/pipe.ts";

const base = { github: { app_id: 1, me: "owner" }, repos: { web: { github: "owner/web" } } };
const jira = (o: Record<string, unknown> = {}) => ({
  site: "https://acme.atlassian.net/",
  email: "owner@example.com",
  token_file: "/tmp/jira-token",
  jql: "project = ABC",
  repos: { web: ["project:ABC", "Component:Billing", "label:API"] },
  ...o,
});
const parse = (j: Record<string, unknown> | undefined) =>
  parseConfig({ ...base, ...(j ? { jira: j } : {}) }, "/c.toml");

test("jira: config reads the table", () => {
  const c = parse(jira());
  expect(c.jira).toEqual({
    site: "https://acme.atlassian.net",
    email: "owner@example.com",
    tokenFile: "/tmp/jira-token",
    jql: "project = ABC",
    repos: new Map([
      [
        "web",
        [
          { kind: "project", value: "abc" },
          { kind: "component", value: "billing" },
          { kind: "label", value: "api" },
        ],
      ],
    ]),
  });
  // Unknown keys are ignored; the other fields are each required.
  expect(parse(jira({ colour: "blue" })).jira?.site).toBe("https://acme.atlassian.net");
  expect(() => parse(jira({ email: undefined }))).toThrow("config: /c.toml: jira.email is required");
  expect(() => parse(jira({ token_file: undefined }))).toThrow("jira.token_file is required");
  expect(() => parse(jira({ token_file: "token" }))).toThrow(
    "jira.token_file must be absolute or start with ~/",
  );
  expect(() => parse(jira({ jql: "  " }))).toThrow("config: /c.toml: jira.jql must not be empty");
});

test("jira: config rejects a bad site", () => {
  for (const site of ["http://acme.atlassian.net", "acme.atlassian.net", "ftp://x.y", ""]) {
    expect(() => parse(jira({ site })), site).toThrow("config: /c.toml: jira.site must be an https URL");
  }
  // http is for a local fake only.
  expect(parse(jira({ site: "http://127.0.0.1:9" })).jira?.site).toBe("http://127.0.0.1:9");
  expect(parse(jira({ site: "http://localhost:9" })).jira?.site).toBe("http://localhost:9");
});

test("jira: config refuses a token file others can read", () => {
  const dir = mkdtempSync(join(tmpdir(), "tc-jcfg-"));
  const token = join(dir, "token");
  const file = join(dir, "config.toml");
  const write = () =>
    writeFileSync(
      file,
      `[github]\napp_id = 1\nme = "owner"\n[jira]\nsite = "https://acme.atlassian.net"\nemail = "a@b.c"\ntoken_file = "${token}"\njql = "project = ABC"\n`,
    );
  write();
  expect(() => loadConfig(file)).toThrow(`config: ${file}: jira.token_file does not exist`);
  writeFileSync(token, "secret\n");
  chmodSync(token, 0o644);
  expect(() => loadConfig(file)).toThrow(`jira.token_file is readable by group or others`);
  chmodSync(token, 0o600);
  expect(loadConfig(file).jira?.tokenFile).toBe(token);
  writeFileSync(token, "\n");
  expect(() => loadConfig(file)).toThrow("jira.token_file is empty");
});

test("jira: no table means no Jira calls", async () => {
  expect(parse(undefined).jira).toBeNull();
  // A loop without `[jira]` never polls Jira: no client is even given.
  const p = new Pipe({ "README.md": "web\n" }, {});
  await p.start();
  await p.loop.pass();
  await p.loop.jiraIdle();
  expect(p.logs.filter((l) => /jira/i.test(l))).toEqual([]);
  p.cleanup();
});

test("jira: an unknown repo in the mapping is a config error", () => {
  expect(() => parse(jira({ repos: { api: ["project:ABC"] } }))).toThrow(
    "config: /c.toml: jira.repos names an unknown repo api",
  );
  expect(() => parse(jira({ repos: { web: ["ABC"] } }))).toThrow("is not project:, component: or label:");
  expect(() => parse(jira({ repos: { web: [] } }))).toThrow("jira.repos.web must be a list");
});
