// A repo's setup-only secrets (PIP-211..214): the file, the encodings that are hidden, the search of what
// setup left behind, and the rules of the secret pass that need no mission.

import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  manifestChanges,
  needsPrivate,
  readSetupSecrets,
  redactSetup,
  SCRIPTS_OFF,
  SetupSecretsError,
  scanDir,
  scanGitFiles,
  setupSecretsPath,
  systemPath,
  unsupportedTool,
} from "../../src/pipeline/setup-secrets.ts";
import { tempDir } from "../helpers/world.ts";

const TOKEN = "npm_Abc123+/xyz789=Q";

/** A secrets file at `mode`, read back. */
function file(text: string, mode = 0o600): string {
  const path = setupSecretsPath(join(tempDir(), "config.toml"), "web");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

function secrets(text: string) {
  return readSetupSecrets(file(text))!;
}

const msg = (path: string): string => {
  try {
    readSetupSecrets(path);
  } catch (e) {
    expect(e).toBeInstanceOf(SetupSecretsError);
    return (e as Error).message;
  }
  throw new Error("accepted");
};

test("pipeline: setup secrets file must be private", () => {
  const path = file(`NPM_TOKEN=${TOKEN}\n`, 0o640);
  expect(msg(path)).toBe(`${path} is readable by others; chmod 600 it`);
  chmodSync(path, 0o604);
  expect(msg(path)).toContain("readable by others");
  chmodSync(path, 0o600);
  expect(readSetupSecrets(path)!.env.NPM_TOKEN).toBe(TOKEN);
  expect(setupSecretsPath("/h/.config/towercab/config.toml", "web")).toBe(
    "/h/.config/towercab/setup-secrets/web.env",
  );
});

test("pipeline: a malformed setup secrets line waits on fix repo files", () => {
  const path = file(`# registry\n\nNPM_TOKEN=${TOKEN}\nthis has no equals sign ${TOKEN}\n`);
  const m = msg(path);
  expect(m).toBe(`${path} line 4 is not KEY=VALUE`);
  expect(m).not.toContain(TOKEN);
  expect(msg(file("1BAD=abcdefghij\n"))).toContain("line 1 is not KEY=VALUE");
  // A variable Towercab sets itself can't be a secret.
  expect(msg(file("PATH=/evil/bin:/usr/bin\n"))).toContain("PATH is set by Towercab");
  expect(msg(file("LD_PRELOAD=/x/evil.so\n"))).toContain("LD_PRELOAD is set by Towercab");
  expect(msg(file("npm_config_ignore_scripts=false\n"))).toContain("is set by Towercab");
});

test("pipeline: a setup secret may have a token-like name", () => {
  const s = secrets("NPM_TOKEN=abcdefgh1\nPIP_INDEX_URL_KEY=abcdefgh2\nCI_JOB_TOKEN=abcdefgh3\n");
  expect(s.tokens.map((t) => t.key)).toEqual(["NPM_TOKEN", "PIP_INDEX_URL_KEY", "CI_JOB_TOKEN"]);
  expect(s.env.CI_JOB_TOKEN).toBe("abcdefgh3");
});

test("pipeline: no setup secrets file means no setup secrets", () => {
  expect(readSetupSecrets(join(tempDir(), "setup-secrets", "web.env"))).toBeNull();
});

test("pipeline: a setup token shorter than 8 characters is refused", () => {
  const path = file("NPM_TOKEN=short12\n");
  expect(msg(path)).toBe(`${path}: NPM_TOKEN is shorter than 8 characters`);
  expect(msg(file("NPM_TOKEN=\n"))).toContain("shorter than 8 characters");
  expect(readSetupSecrets(file("NPM_TOKEN=eight888\n"))!.tokens).toHaveLength(1);
});

test("pipeline: a setup token username is read from the line next to it", () => {
  const s = secrets("NPM_TOKEN=abcdefgh1234\nNPM_TOKEN_USERNAME=bob\n");
  expect(s.pairs).toEqual([{ key: "NPM_TOKEN", user: "bob", token: "abcdefgh1234" }]);
  // The username is not a token: no length rule, not a secret.
  expect(s.tokens.map((t) => t.key)).toEqual(["NPM_TOKEN"]);
  expect(s.env.NPM_TOKEN_USERNAME).toBe("bob");
  // A username line with no token line is an ordinary secret line.
  expect(msg(file("LONELY_USERNAME=bob\n"))).toContain("LONELY_USERNAME is shorter than 8 characters");
});

test("pipeline: a setup secret that holds a url is refused", () => {
  const path = file("NPM_TOKEN=https://user:pw12345678@registry.example.com/\n");
  expect(msg(path)).toBe(`${path}: NPM_TOKEN must hold the token only`);
  expect(msg(file('NPM_TOKEN="abcdefghij"\n'))).toContain("must hold the token only");
  expect(msg(file("NPM_TOKEN=abcd efghij\n"))).toContain("must hold the token only");
});

test("pipeline: a url-encoded setup secret is redacted", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const upper = encodeURIComponent(TOKEN);
  const lower = upper.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
  const out = redactSetup(s, `a ${TOKEN} b ${upper} c ${lower} d`);
  expect(out).toBe("a [redacted] b [redacted] c [redacted] d");
});

test("pipeline: a base64 setup secret is redacted in every alignment", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const std = (t: string) => Buffer.from(t).toString("base64");
  const urlsafe = (t: string) => std(t).replace(/\+/g, "-").replace(/\//g, "_");
  for (const pad of ["", " ", "  "]) {
    const text = `${pad}${TOKEN} and more text after it`;
    for (const enc of [std(text), urlsafe(text), std(text).replace(/=+$/, "")]) {
      const out = redactSetup(s, `log: ${enc} end`);
      // The part that holds the token is gone: nothing of the token's own encoding is left.
      expect(out).toContain("[redacted]");
      const bare = Buffer.from(TOKEN).toString("base64").replace(/=+$/, "");
      expect(out).not.toContain(bare.slice(4, -2));
    }
  }
  // The token alone, with and without padding, standard and URL-safe.
  const alone = std(TOKEN);
  expect(redactSetup(s, alone)).toBe("[redacted]");
  expect(redactSetup(s, alone.replace(/=+$/, ""))).toBe("[redacted]");
  expect(redactSetup(s, urlsafe(TOKEN))).toBe("[redacted]");
});

test("pipeline: a basic-auth header built from the username and token is redacted", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\nNPM_TOKEN_USERNAME=deploy-bot\n`);
  const basic = Buffer.from(`deploy-bot:${TOKEN}`).toString("base64");
  expect(redactSetup(s, `Authorization: Basic ${basic}`)).toBe("Authorization: Basic [redacted]");
  expect(redactSetup(s, `bare ${basic}`)).toBe("bare [redacted]");
  expect(redactSetup(s, `Authorization: Basic ${basic.replace(/=+$/, "")}`)).toBe(
    "Authorization: Basic [redacted]",
  );
});

test("pipeline: a setup username alone is not redacted", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\nNPM_TOKEN_USERNAME=deploy-bot\n`);
  expect(redactSetup(s, "logged in as deploy-bot")).toBe("logged in as deploy-bot");
  expect(redactSetup(s, `deploy-bot:${TOKEN}`)).toBe("deploy-bot:[redacted]");
});

test("pipeline: a setup secret in git config stops the stage", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const checkout = tempDir();
  mkdirSync(join(checkout, ".git", "hooks"), { recursive: true });
  writeFileSync(join(checkout, ".git", "config"), `[url "https://x:${TOKEN}@host/"]\n`);
  expect(scanGitFiles(checkout, s)).toEqual({ path: join(".git", "config"), key: "NPM_TOKEN" });
  writeFileSync(join(checkout, ".git", "config"), "[core]\n");
  expect(scanGitFiles(checkout, s)).toBeNull();
  writeFileSync(join(checkout, ".git", "hooks", "pre-push"), `curl ${TOKEN}`);
  expect(scanGitFiles(checkout, s)?.path).toBe(join(".git", "hooks", "pre-push"));
});

test("pipeline: git objects are not scanned", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const checkout = tempDir();
  mkdirSync(join(checkout, ".git", "objects", "ab"), { recursive: true });
  writeFileSync(join(checkout, ".git", "objects", "ab", "cdef"), TOKEN);
  expect(scanGitFiles(checkout, s)).toBeNull();
  // The checkout scan leaves `.git` to the git files' own search.
  expect(scanDir(checkout, "", s, { skip: [".git"] })).toBeNull();
});

test("pipeline: the setup secret scan covers ignored files", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const tree = tempDir();
  mkdirSync(join(tree, "node_modules", ".cache"), { recursive: true });
  writeFileSync(join(tree, "node_modules", ".cache", "auth.json"), `{"t":"${TOKEN}"}`);
  expect(scanDir(tree, "", s)).toEqual({
    path: join("node_modules", ".cache", "auth.json"),
    key: "NPM_TOKEN",
  });
});

test("pipeline: the setup secret scan names the file and key and not the value", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const tree = tempDir();
  writeFileSync(join(tree, "out.txt"), `before\n${TOKEN}\nafter\n`);
  const hit = scanDir(tree, "", s)!;
  expect(hit).toEqual({ path: "out.txt", key: "NPM_TOKEN" });
  expect(JSON.stringify(hit)).not.toContain(TOKEN);
  // A token that is encoded in the file is found too, and a big file is read in chunks.
  writeFileSync(join(tree, "out.txt"), `${"x".repeat(3_000_000)}${encodeURIComponent(TOKEN)}`);
  expect(scanDir(tree, "", s)?.key).toBe("NPM_TOKEN");
});

test("pipeline: a setup secret in the credentials folder stops the stage", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const creds = tempDir();
  writeFileSync(join(creds, "npmrc"), `//registry.example.com/:_authToken=${TOKEN}\n`);
  expect(scanDir(creds, "setup-creds", s)).toEqual({ path: join("setup-creds", "npmrc"), key: "NPM_TOKEN" });
  expect(scanDir(tempDir(), "setup-creds", s)).toBeNull();
});

test("pipeline: a setup secret in a changed cache file stops the stage", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  const cache = tempDir();
  mkdirSync(join(cache, "npm"), { recursive: true });
  writeFileSync(join(cache, "npm", "small"), TOKEN);
  writeFileSync(join(cache, "npm", "big"), `${TOKEN}${"x".repeat(300 * 1024)}`);
  const start = Date.now() - 5000;
  const want = (size: number, mtime: number) => size <= 256 * 1024 && mtime >= start;
  expect(scanDir(cache, "cache", s, { want })).toEqual({
    path: join("cache", "npm", "small"),
    key: "NPM_TOKEN",
  });
  // Older than the run, or over 256 KiB: not read.
  expect(scanDir(cache, "cache", s, { want: (z, t) => want(z, t) && t > Date.now() + 1000 })).toBeNull();
  writeFileSync(join(cache, "npm", "small"), "clean");
  expect(scanDir(cache, "cache", s, { want })).toBeNull();
});

test("pipeline: install scripts are switched off in the secret pass", () => {
  expect(SCRIPTS_OFF).toEqual({
    npm_config_ignore_scripts: "true",
    YARN_ENABLE_SCRIPTS: "false",
    PIP_ONLY_BINARY: ":all:",
    UV_NO_BUILD: "1",
  });
});

test("pipeline: a setup tool with no scripts switch is refused with secrets", () => {
  expect(unsupportedTool(["npm ci"])).toBeNull();
  expect(unsupportedTool(["pip install -r requirements.txt", "pnpm install"])).toBeNull();
  expect(unsupportedTool(["cargo fetch"])).toBe("cargo");
  expect(unsupportedTool(["npm ci && make deps"])).toBe("make");
  expect(unsupportedTool(["FOO=1 go mod download"])).toBe("go");
  expect(unsupportedTool(["sh -c 'bundle install'"])).toBe("bundle");
  expect(unsupportedTool(["/usr/bin/gradle build"])).toBe("gradle");
  // A word that only contains a tool's name is not the tool.
  expect(unsupportedTool(["echo cargo-less; ls gomod"])).toBeNull();
});

test("pipeline: the secret pass path is the system directories only", () => {
  const home = tempDir();
  const path = systemPath(home, "/h/work/1", "/h/work/1-setup-tree").split(":");
  for (const d of path) {
    expect(d.startsWith("/")).toBe(true);
    expect(d).not.toContain("node_modules");
    expect(d).not.toBe(join(home, ".local", "bin"));
    expect(d.startsWith("/h/work/1")).toBe(false);
  }
  expect(path).toContain("/usr/bin");
  // An entry inside the checkout, and a relative one, are dropped.
  expect(systemPath(home, home).split(":")).not.toContain(join(home, ".cargo", "bin"));
});

test("pipeline: an unchanged manifest gets no second pass", () => {
  expect(manifestChanges(["src/a.ts", "README.md", "docs/package.json.md"])).toEqual([]);
  expect(manifestChanges([])).toEqual([]);
});

test("pipeline: a manifest or lockfile at any depth asks for a second pass", () => {
  const all = [
    "package.json",
    "web/package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "requirements-dev.txt",
    "a/b/pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    ".npmrc",
    "pip.conf",
    "setup.py",
    "setup.cfg",
  ];
  expect(manifestChanges([...all, "src/index.ts"])).toEqual(all);
});

test("pipeline: a refused registry in a second pass is told from other failures", () => {
  expect(needsPrivate("npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://npm.corp/@corp/x")).toBe(
    true,
  );
  expect(needsPrivate("npm ERR! 401 Unauthorized")).toBe(true);
  expect(needsPrivate("error: test failed\nAssertionError")).toBe(false);
});

test("pipeline: a setup secret split across output chunks is redacted", () => {
  const s = secrets(`NPM_TOKEN=${TOKEN}\n`);
  // The child wrote the token in two pieces; the file is redacted whole, after the run.
  const log = join(tempDir(), "setup.log");
  writeFileSync(log, `$ npm ci\nauth ${TOKEN.slice(0, 9)}`);
  appendFileSync(log, `${TOKEN.slice(9)} done\n`);
  expect(redactSetup(s, readFileSync(log, "utf8"))).toBe("$ npm ci\nauth [redacted] done\n");
});
