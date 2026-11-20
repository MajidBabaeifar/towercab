// Second review fixes (PIP-212, PIP-213, PIP-214): other workers can't read the setup folders, redaction uses the
// values the pass started with, and a missing branch start stops the stage.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { othersInHome } from "../../src/claude.ts";
import type { Ctx } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import { startSecretPass } from "../../src/pipeline/setup-pass.ts";
import { build, CLAUDE_MD, happy, ID, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

test("claude: the setup folders of other missions are unreadable before they exist", () => {
  const home = tempDir();
  for (const d of ["work/a-1", "work/b-1", "runs/a", "runs/b", "cache/web"])
    mkdirSync(join(home, d), { recursive: true });
  const deny = othersInHome({
    cwd: join(home, "work", "a-1"),
    runsDir: join(home, "runs", "a"),
    cache: join(home, "cache", "web"),
  });
  for (const x of ["setup-tree", "setup-creds", "setup-cache", "setup-index"])
    expect(deny).toContain(join(home, "work", `b-1-${x}`));
  expect(deny).not.toContain(join(home, "work", "a-1-setup-creds"));
});

test("pipeline: a setup secret rotated while setup runs is still redacted", async () => {
  const OLD = "tok_OldValue_1a2b3c4d5e";
  const NEW = "tok_NewValue_9z8y7x6w5v";
  const p = new Pipe(
    {
      ...TARGET,
      "CLAUDE.md": CLAUDE_MD.replace(
        "## Verifying your work\n",
        "## Verifying your work\n\n```setup\nsh ci/install.sh\n```\n",
      ),
      "ci/install.sh": 'echo "token:$NPM_TOKEN"\n',
    },
    intents(intent({ a: 5 })),
    { keep: true },
  );
  try {
    happy(p);
    const file = join(p.home.root, "setup-secrets", "web.env");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `NPM_TOKEN=${OLD}\n`);
    chmodSync(file, 0o600);
    p.sandbox = (spec) => {
      if (spec.stdout.includes("/build/")) {
        // The owner rotates the token (and later removes the file) while the pass runs.
        writeFileSync(file, `NPM_TOKEN=${NEW}\n`);
        chmodSync(file, 0o600);
      }
      return null;
    };
    await p.start();
    const log = join(p.home.runs(ID, "build"), "build-setup.log");
    await p.until(() => p.claudeCalls.some((c) => c.kind === "worker"), 40);
    expect(readFileSync(log, "utf8")).toContain("token:[redacted]");
    expect(readFileSync(log, "utf8")).not.toContain(OLD);
    expect(build()).toBeTruthy();
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: setup secrets stop the stage when the branch's start can't be found", async () => {
  const dir = join(tempDir(), "co");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  const config = join(tempDir(), "config.toml");
  const secrets = join(config, "..", "setup-secrets", "web.env");
  mkdirSync(join(secrets, ".."), { recursive: true });
  writeFileSync(secrets, "NPM_TOKEN=tok_Abcdefgh12345\n");
  chmodSync(secrets, 0o600);
  const cx = {
    tools: new FakeTools(),
    config: { file: config },
    repo: () => ({ base: "main" }),
    record: (m: Mission) => m,
  } as unknown as Ctx;
  const m = { repo: "web", step: "setup-secret" } as Mission;
  const out = await startSecretPass(cx, m, {
    kind: "setup",
    dir,
    lines: ["npm ci"],
    log: join(dir, "l.log"),
    timeoutMs: 1000,
  });
  expect(out && "done" in out ? out.done.event : null).toBe("wait");
  expect(JSON.stringify(out)).toContain("fix repo files");
  // Nothing was exported or made.
  expect(existsSync(`${dir}-setup-tree`)).toBe(false);
  expect(existsSync(`${dir}-setup-creds`)).toBe(false);
});
