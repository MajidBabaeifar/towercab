// Program, home and config (LOOP-1): every default of **Config**, errors that name the key, and the
// home folder's layout.

import { statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { checkLoop, clonePath, DEFAULT_NETWORK, loadConfig, parseConfig } from "../src/config.ts";
import { Home } from "../src/home.ts";
import { FakeTools } from "./helpers/tools.ts";
import { tempDir } from "./helpers/world.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["HOME", "TOWERCAB_HOME", "TOWERCAB_CONFIG", "PATH"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

test("config: loads defaults", () => {
  process.env.HOME = tempDir("tc-user-");
  process.env.PATH = "/opt/node/bin:/usr/bin:/bin";
  const c = parseConfig(
    {
      intents: { remote: "https://github.com/me/intents.git", unknown: 1 },
      repos: { web: { github: "me/web" } },
      github: { app_id: 7, me: "me" },
      surprise: { key: "ignored" },
    },
    "/x/config.toml",
  );
  expect(c.intents).toEqual({
    remote: "https://github.com/me/intents.git",
    path: null,
    cutoff: 7,
    issueA: 3,
    ownerWaits: 4,
  });
  expect(c.agent).toEqual({
    model: "opus",
    reviewModel: null,
    parallel: 1,
    buildTimeoutMin: 60,
    reviewTimeoutMin: 15,
    checkTimeoutMin: 10,
    maxBudgetUsd: 10,
    dailyBudgetUsd: null,
    ciPoll: 30,
    ciGrace: 120,
    ciWait: 1800,
    freezeWaitMin: 120,
    path: "/opt/node/bin:/usr/bin:/bin",
    toolchain: [join(process.env.HOME, ".local/bin")],
    env: {},
    network: DEFAULT_NETWORK,
    sandboxUnixSockets: false,
  });
  expect(DEFAULT_NETWORK).toEqual([
    "registry.npmjs.org",
    "*.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "*.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "docs.rs",
    "nodejs.org",
    "developer.mozilla.org",
  ]);
  const web = c.repos.get("web")!;
  expect(web).toEqual({
    name: "web",
    github: "me/web",
    path: "",
    base: "main",
    workers: 1,
    ahead: 3,
    env: {},
  });
  expect(clonePath(web, "/h")).toBe("/h/repos/web");
  expect(c.github).toEqual({ appId: 7, me: "me", apiBase: "https://api.github.com" });
  expect(c.telegram).toBeNull();
  expect(c.ui).toEqual({ port: 7311 });
  expect(c.update).toEqual({ auto: true, drainMinutes: 60 });
  expect(c.badRepos.size).toBe(0);
  // `~/` is expanded, and v1's [tasks] is read as [intents] when [intents] is absent.
  const t = parseConfig(
    { tasks: { remote: "r", path: "~/intents", cutoff: 9 }, agent: { toolchain: ["~/bin", "/opt/x"] } },
    "/x/config.toml",
  );
  expect(t.intents).toEqual({
    remote: "r",
    path: join(homedir(), "intents"),
    cutoff: 9,
    issueA: 3,
    ownerWaits: 4,
  });
  expect(t.agent.toolchain).toEqual([join(homedir(), "bin"), "/opt/x"]);
  expect(parseConfig({ tasks: { remote: "old" }, intents: { remote: "new" } }, "f").intents.remote).toBe(
    "new",
  );
  const tg = parseConfig({ telegram: { bot_token: "t", chat_id: 42 } }, "f").telegram;
  expect(tg).toEqual({ botToken: "t", chatId: "42", apiBase: "https://api.telegram.org" });
});

test("config: owner_waits default and range", () => {
  const read = (intents: Record<string, unknown>) =>
    parseConfig({ intents: { remote: "r", ...intents } }, "f");
  expect(read({}).intents.ownerWaits).toBe(4);
  expect(read({ owner_waits: 2 }).intents.ownerWaits).toBe(2);
  expect(read({ owner_waits: 16 }).intents.ownerWaits).toBe(16);
  expect(() => read({ owner_waits: 0 })).toThrow("intents.owner_waits must be an integer 1-16");
  expect(() => read({ owner_waits: 17 })).toThrow("intents.owner_waits must be an integer 1-16");
});

test("config: bad values name the key", async () => {
  const dir = tempDir("tc-config-");
  const file = join(dir, "config.toml");
  const err = (text: string) => {
    writeFileSync(file, `[intents]\nremote = "r"\n${text}\n`);
    try {
      loadConfig(file);
    } catch (e) {
      return (e as Error).message;
    }
    return "loaded";
  };
  const cases: [string, string][] = [
    ["[intents]\ncutoff = 0", "intents.cutoff must be an integer 1-15"],
    ["[intents]\nissue_a = 6", "intents.issue_a must be an integer 1-5"],
    ["[agent]\nparallel = 17", "agent.parallel must be an integer 1-16"],
    ['[agent]\nbuild_timeout = "60"', "agent.build_timeout must be an integer 1-1440"],
    ["[agent]\nreview_timeout = 1441", "agent.review_timeout must be an integer 1-1440"],
    ["[agent]\nmax_budget_usd = 0", "agent.max_budget_usd must be a number above 0, at most 1000"],
    ["[agent]\nci_poll = 1", "agent.ci_poll must be an integer 5-3600"],
    ["[agent]\nfreeze_wait = 0", "agent.freeze_wait must be an integer 1-1440"],
    ["[agent]\nfreeze_wait = 1441", "agent.freeze_wait must be an integer 1-1440"],
    ['[agent]\nmodel = "two words"', "agent.model must be a non-empty word"],
    ['[agent]\ntoolchain = ["rel/bin"]', "agent.toolchain: rel/bin is not absolute"],
    ["[agent]\nenv = { X = 1 }", "agent.env.X must be a string"],
    ['[agent]\nnetwork = ["ok", ""]', "agent.network must be a list of non-empty strings"],
    ['[agent]\nsandbox_unix_sockets = "yes"', "agent.sandbox_unix_sockets must be true or false"],
    ['[github]\napp_id = 1\nme = "not a login"', "github.me must be a GitHub login"],
    ['[github]\napp_id = 1\nme = "me"\napi_base = "ftp://x"', "github.api_base must be an http(s) URL"],
    ["[ui]\nport = 70000", "ui.port must be an integer 0-65535"],
    ['[update]\nauto = "yes"', "update.auto must be true or false"],
    ["[update]\ndrain_minutes = 0", "update.drain_minutes must be an integer 1-1440"],
    ['[update]\ndrain_minutes = "60"', "update.drain_minutes must be an integer 1-1440"],
    ['[telegram]\nbot_token = "t"', "telegram.bot_token and telegram.chat_id are required"],
  ];
  for (const [text, what] of cases) {
    // The TOML is merged after [intents]; a section repeated is a parse error, so give it its own file.
    const body = text.startsWith("[intents]") ? text.replace("[intents]\n", "") : text;
    expect(err(body), text).toBe(`config: ${file}: ${what}`);
  }
  expect(() => parseConfig({ agent: 3 }, file)).toThrow(`config: ${file}: agent must be a table`);
  expect(err("[intents")).toMatch(new RegExp(`^config: ${file}: `));
  expect(() => loadConfig(join(dir, "none.toml"))).toThrow(`config: ${join(dir, "none.toml")}: missing`);
  // A bad repo fails only what uses it; with no good repo, `run` and `up` refuse with its reason.
  writeFileSync(
    file,
    '[intents]\nremote = "r"\n[github]\napp_id = 1\nme = "me"\n[repos.web]\ngithub = "web"\n',
  );
  const c = loadConfig(file);
  expect(c.badRepos.get("web")).toBe(`config: ${file}: repos.web.github must be owner/name`);
  expect(() => checkLoop(c)).toThrow(`config: ${file}: repos.web.github must be owner/name`);
  // The CLI prints it and exits 1.
  writeFileSync(file, '[intents]\nremote = "r"\n[agent]\nparallel = 0\n');
  const out: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  expect(await main(["--config", file, "--home", dir, "status"], new FakeTools())).toBe(1);
  expect(out.join("")).toBe(`towercab: config: ${file}: agent.parallel must be an integer 1-16\n`);
});

test("home: layout", () => {
  const user = tempDir("tc-user-");
  process.env.HOME = user;
  delete process.env.TOWERCAB_HOME;
  // --home > TOWERCAB_HOME > ~/.local/share/towercab, created 0700.
  const flag = join(tempDir("tc-flag-"), "h");
  process.env.TOWERCAB_HOME = join(user, "env-home");
  expect(Home.resolve(flag).root).toBe(flag);
  expect(Home.resolve().root).toBe(join(user, "env-home"));
  delete process.env.TOWERCAB_HOME;
  const h = Home.resolve();
  expect(h.root).toBe(join(user, ".local/share/towercab"));
  for (const d of [flag, join(user, "env-home"), h.root]) expect(statSync(d).mode & 0o777).toBe(0o700);
  expect(Home.resolve("~/elsewhere").root).toBe(join(user, "elsewhere"));
  // The files and folders in it.
  expect(h.db).toBe(join(h.root, "towercab.db"));
  expect(h.lockPath).toBe(join(h.root, "towercab.lock"));
  expect(h.logFile).toBe(join(h.root, "towercab.log"));
  expect(h.intents).toBe(join(h.root, "intents"));
  expect(h.repo("web")).toBe(join(h.root, "repos/web"));
  expect(h.workRel("261026-1000", 2)).toBe("work/261026-1000-2");
  expect(h.abs(h.workRel("261026-1000", 2))).toBe(join(h.root, "work/261026-1000-2"));
  expect(h.runs("261026-1000")).toBe(join(h.root, "runs/261026-1000"));
  expect(statSync(join(h.root, "runs/261026-1000")).isDirectory()).toBe(true);
  expect(h.cache("web")).toBe(join(h.root, "cache/web"));
  expect(statSync(join(h.root, "cache/web")).isDirectory()).toBe(true);
});

test("config: ahead default and range", () => {
  const parse = (ahead?: number) =>
    parseConfig(
      {
        intents: { remote: "r" },
        repos: { web: { github: "me/web", ...(ahead === undefined ? {} : { ahead }) } },
      },
      "c.toml",
    );
  expect(parse().repos.get("web")?.ahead).toBe(3);
  expect(parse(1).repos.get("web")?.ahead).toBe(1);
  expect(parse(16).repos.get("web")?.ahead).toBe(16);
  for (const bad of [0, 17]) {
    expect(parse(bad).badRepos.get("web")).toBe("config: c.toml: repos.web.ahead must be an integer 1-16");
  }
});
