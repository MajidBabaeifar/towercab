// A repo's setup secrets in the pipeline (PIP-211..214): where they go, where they never go, what is
// searched for and redacted, and how a branch's own code is kept away from them.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ChildSpec } from "../../src/tools.ts";
import { build, CLAUDE_MD, CODE, happy, ID, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const TOKEN = "tok_Secr3tValue_9f8e7d6c";
const USER = "deploy-bot";

const INSTALL = `mkdir -p .venv && echo ok > .venv/pkg.txt
echo not-ignored > leftover.txt
echo "registry token:\${NPM_TOKEN:-none}"
if grep -q postinstall package.json; then echo "postinstall ran"; fi
echo "script: main"
`;
const SETUP_MD = `${CLAUDE_MD.replace("## Verifying your work\n", "## Verifying your work\n\n```setup\nsh ci/install.sh\n```\n")}`;
const BRANCH = {
  ...CODE,
  "package.json": '{"name":"web","scripts":{"postinstall":"sh evil.sh"}}\n',
  "ci/install.sh": `${INSTALL}echo "script: branch"\n`,
  "node_modules/.bin/npm": "#!/bin/sh\ntouch planted-ran\n",
};

function target(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...TARGET,
    "CLAUDE.md": SETUP_MD,
    ".gitignore": ".venv/\n",
    "package.json": '{"name":"web"}\n',
    "ci/install.sh": INSTALL,
    ...extra,
  };
}

/** What a sandboxed run saw when it started, recorded by the fake bwrap. */
interface Seen {
  kind: string;
  spec: ChildSpec;
  /** The folder it runs in holds a planted `node_modules/.bin/npm`. */
  planted: boolean;
  pkg: string;
  hasGit: boolean;
  hasWorkerFile: boolean;
  creds: string[] | null;
  checkoutHas: Record<string, boolean>;
}

function seeing(p: Pipe, seen: Seen[], then?: (spec: ChildSpec, n: number) => { code: number } | null): void {
  p.sandbox = (spec) => {
    const dir = spec.cwd;
    const creds = `${spec.argv.find((a) => a.endsWith("-setup-creds")) ?? ""}`;
    seen.push({
      kind: spec.kind,
      spec,
      planted: existsSync(join(dir, "node_modules", ".bin", "npm")),
      pkg: existsSync(join(dir, "package.json")) ? readFileSync(join(dir, "package.json"), "utf8") : "",
      hasGit: existsSync(join(dir, ".git")),
      hasWorkerFile: existsSync(join(dir, "greeting.txt")),
      creds: creds && existsSync(creds) ? readdirSync(creds) : null,
      checkoutHas: {
        venv: existsSync(join(dir, ".venv", "pkg.txt")),
        leftover: existsSync(join(dir, "leftover.txt")),
      },
    });
    const r = then?.(spec, seen.length);
    if (!r) return null;
    return { code: r.code, signal: null };
  };
}

function secrets(p: Pipe, text = `NPM_TOKEN=${TOKEN}\nNPM_TOKEN_USERNAME=${USER}\n`, mode = 0o600): void {
  const path = join(p.home.root, "setup-secrets", "web.env");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

const setups = (seen: Seen[]) => seen.filter((s) => s.kind === "setup");
const treeRuns = (seen: Seen[]) => seen.filter((s) => s.spec.argv.some((a) => a.endsWith("-setup-tree")));
const claudes = (p: Pipe) => p.tools.spawned.filter((s) => s.argv[0] === "claude");
const workers = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "worker");

async function run(p: Pipe, until: (p: Pipe) => boolean): Promise<void> {
  await p.start();
  await p.until(() => until(p), 80);
}

const published = (p: Pipe) => (p.mission() ? p.stages(p.mission()!.id).includes("publish") : false);

// ── The happy path: a branch that edits the manifest, a script setup calls and plants a bin tool ──────────

let a: Pipe;
const seenA: Seen[] = [];

beforeAll(async () => {
  a = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  happy(a);
  a.respond.worker = reply(build(), BRANCH);
  secrets(a);
  seeing(a, seenA);
  await run(a, published);
}, 60_000);

afterAll(() => a.cleanup());

const checkoutOfA = () => join(a.home.root, "work", `${ID}-1`);

test("pipeline: setup with secrets runs on a fresh export of the base commit's tree (flow)", () => {
  expect(a.stages(a.mission()!.id), a.moves()).toContain("publish");
  const verify = treeRuns(seenA).filter((s) => s.spec.stdout.includes("/verify/"));
  expect(verify.length).toBeGreaterThan(0);
  for (const s of treeRuns(seenA)) {
    expect(s.spec.cwd.endsWith("-setup-tree")).toBe(true);
    expect(s.hasGit).toBe(false);
    // Main's manifest, none of the branch's files.
    expect(s.pkg).toBe('{"name":"web"}\n');
    expect(s.hasWorkerFile).toBe(false);
  }
});

test("pipeline: the secret pass does not mount the worker's checkout", () => {
  const checkout = checkoutOfA();
  for (const s of treeRuns(seenA)) {
    const argv = s.spec.argv;
    expect(argv.some((x, i) => x === "--bind" && argv[i + 1] === checkout)).toBe(false);
    expect(argv.some((x, i) => x === "--ro-bind-try" && argv[i + 1] === join(checkout, ".git"))).toBe(false);
  }
});

test("pipeline: the secret pass binds its tree at the checkout path", () => {
  expect(treeRuns(seenA).length).toBeGreaterThan(0);
  for (const s of treeRuns(seenA)) {
    const argv = s.spec.argv;
    const at = s.spec.cwd.replace(/-setup-tree$/, "");
    const i = argv.findIndex((x, k) => x === "--bind" && argv[k + 1] === s.spec.cwd);
    expect(argv.slice(i, i + 3)).toEqual(["--bind", s.spec.cwd, at]);
    expect(argv[argv.indexOf("--chdir") + 1]).toBe(at);
  }
});

test("pipeline: a branch that plants a fake node_modules bin tool does not run it in the secret pass", () => {
  const checkout = checkoutOfA();
  expect(treeRuns(seenA).length).toBeGreaterThan(0);
  for (const s of treeRuns(seenA)) {
    expect(s.planted).toBe(false);
    const path = (s.spec.env.PATH ?? "").split(":");
    for (const d of path) {
      expect(d.startsWith("/")).toBe(true);
      expect(d.startsWith(checkout)).toBe(false);
      expect(d).not.toContain("node_modules");
    }
  }
  // The branch's tool is in the checkout, where the second pass has no secret to give it.
  const second = setups(seenA).find((s) => s.spec.stdout.endsWith("-setup-open.log"))!;
  expect(second.planted).toBe(true);
  expect(existsSync(join(checkout, "planted-ran"))).toBe(false);
});

test("pipeline: setup gets its own empty credentials folder", () => {
  const checkout = checkoutOfA();
  const first = treeRuns(seenA)[0]!;
  const creds = `${checkout}-setup-creds`;
  const argv = first.spec.argv;
  expect(argv.some((x, i) => x === "--bind" && argv[i + 1] === creds && argv[i + 2] === creds)).toBe(true);
  expect(first.creds).toEqual([]);
  expect(first.spec.env.NPM_CONFIG_USERCONFIG).toBe(join(creds, "npmrc"));
  expect(first.spec.env.PIP_CONFIG_FILE).toBe(join(creds, "pip.conf"));
  expect(first.spec.env.XDG_CONFIG_HOME).toBe(join(creds, "xdg"));
  expect(first.spec.env.POETRY_CONFIG_DIR).toBe(join(creds, "poetry"));
  // Deleted after the scan.
  expect(existsSync(creds)).toBe(false);
  expect(existsSync(`${checkout}-setup-tree`)).toBe(false);
});

test("pipeline: the credentials folder is not bound into the worker or the checks", () => {
  const not = seenA.filter((s) => !treeRuns(seenA).includes(s));
  expect(not.length).toBeGreaterThan(0);
  for (const s of not) {
    expect(s.spec.argv.join(" ")).not.toContain("setup-creds");
    expect(JSON.stringify(s.spec.env)).not.toContain("setup-creds");
  }
  for (const c of a.claudeCalls) expect(JSON.stringify(c.settings)).not.toContain("setup-creds");
  for (const s of claudes(a)) expect(JSON.stringify(s.env)).not.toContain("setup-creds");
});

test("pipeline: the shared cache is read-only for the worker when the repo has setup secrets", () => {
  const cache = a.home.cache("web");
  expect(workers(a).length).toBeGreaterThan(0);
  for (const c of a.claudeCalls) {
    const fs = (c.settings.sandbox as { filesystem: { allowWrite?: string[] } }).filesystem;
    expect(fs.allowWrite ?? []).not.toContain(cache);
  }
  // Setup still writes it.
  const first = treeRuns(seenA)[0]!;
  const argv = first.spec.argv;
  expect(argv[argv.indexOf(cache) - 1]).toBe("--bind");
});

test("pipeline: setup secrets are set for setup commands only", () => {
  const withToken = seenA.filter((s) => s.spec.env.NPM_TOKEN === TOKEN);
  expect(withToken.length).toBeGreaterThan(0);
  for (const s of withToken) expect(["setup", "proof-setup"]).toContain(s.kind);
  for (const s of treeRuns(seenA)) {
    expect(s.spec.env.NPM_TOKEN).toBe(TOKEN);
    expect(s.spec.env.NPM_TOKEN_USERNAME).toBe(USER);
    // Scripts are off, over anything else.
    expect(s.spec.env.npm_config_ignore_scripts).toBe("true");
    expect(s.spec.env.YARN_ENABLE_SCRIPTS).toBe("false");
    expect(s.spec.env.PIP_ONLY_BINARY).toBe(":all:");
    expect(s.spec.env.UV_NO_BUILD).toBe("1");
  }
});

test("pipeline: the worker environment never holds a setup secret", () => {
  const all = claudes(a);
  expect(all.length).toBeGreaterThan(3);
  expect(all.some((s) => s.kind === "worker")).toBe(true);
  for (const s of all) {
    const text = JSON.stringify({ env: s.env, argv: s.argv });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("NPM_TOKEN");
    expect(Object.keys(s.env)).not.toContain("NPM_TOKEN_USERNAME");
  }
  for (const c of a.claudeCalls) {
    expect(JSON.stringify(c.settings)).not.toContain(TOKEN);
    expect(c.prompt).not.toContain(TOKEN);
  }
});

test("pipeline: a check and an e2e suite do not see setup secrets", () => {
  const rest = seenA.filter((s) => !["setup", "proof-setup", "e2e-setup"].includes(s.kind));
  expect(rest.map((s) => s.kind)).toContain("checks");
  for (const s of rest) {
    expect(JSON.stringify(s.spec.env)).not.toContain(TOKEN);
    expect(Object.keys(s.spec.env)).not.toContain("NPM_TOKEN");
  }
  // The second pass and the suites are built without them: the second pass is a plain setup.
  const second = setups(seenA).find((s) => s.spec.stdout.endsWith("-setup-open.log"))!;
  expect(Object.keys(second.spec.env)).not.toContain("NPM_TOKEN");
});

test("pipeline: no prompt or PR text holds a setup secret", () => {
  const b64 = Buffer.from(`${USER}:${TOKEN}`).toString("base64");
  const bad = [TOKEN, encodeURIComponent(TOKEN), Buffer.from(TOKEN).toString("base64"), b64];
  const texts = [
    ...a.claudeCalls.map((c) => c.prompt),
    ...a.prs.flatMap((p) => [p.title, p.body, ...p.comments.map((c) => c.body)]),
    ...a.forge.calls,
    ...a.logs,
    ...a.db.all<{ text: string }>("SELECT text FROM outbox").map((o) => o.text),
    ...a.db
      .all<{ data: string; why: string | null }>("SELECT data, why FROM missions")
      .flatMap((r) => [r.data, r.why ?? ""]),
  ];
  expect(texts.length).toBeGreaterThan(10);
  for (const t of texts) for (const b of bad) expect(t).not.toContain(b);
});

test("pipeline: setup secrets are redacted from the verify log", () => {
  const verify = readFileSync(join(a.home.runs(ID, "verify"), "verify-1-setup.log"), "utf8");
  expect(verify).toContain("registry token:[redacted]");
  expect(verify).not.toContain(TOKEN);
  const built = readFileSync(join(a.home.runs(ID, "build"), "build-setup.log"), "utf8");
  expect(built).toContain("registry token:[redacted]");
  expect(built).not.toContain(TOKEN);
  expect(existsSync(join(a.home.runs(ID, "verify"), "verify-1-setup.log.err"))).toBe(false);
});

test("pipeline: a branch that adds a postinstall script does not run it in the secret pass", () => {
  const verify = readFileSync(join(a.home.runs(ID, "verify"), "verify-1-setup.log"), "utf8");
  expect(verify).not.toContain("postinstall ran");
  expect(verify).toContain("script: main");
  expect(verify).not.toContain("script: branch");
});

test("pipeline: a branch that changes a script the setup calls does not run it with the secret", () => {
  for (const s of treeRuns(seenA)) expect(s.checkoutHas).toBeDefined();
  const verify = readFileSync(join(a.home.runs(ID, "verify"), "verify-1-setup.log"), "utf8");
  expect(verify).toContain("script: main");
  // The branch's version only ran in the second pass, with no token.
  const open = readFileSync(join(a.home.runs(ID, "verify"), "verify-1-setup-open.log"), "utf8");
  expect(open).toContain("script: branch");
  expect(open).toContain("registry token:none");
});

test("pipeline: a branch that adds a postinstall script runs it in pass 2 with no secret in its environment", () => {
  const open = readFileSync(join(a.home.runs(ID, "verify"), "verify-1-setup-open.log"), "utf8");
  expect(open).toContain("postinstall ran");
  const second = setups(seenA).find((s) => s.spec.stdout.endsWith("-setup-open.log"))!;
  expect(Object.keys(second.spec.env).filter((k) => /NPM_TOKEN|NPM_CONFIG_USERCONFIG/.test(k))).toEqual([]);
  expect(JSON.stringify(second.spec.env)).not.toContain(TOKEN);
});

test("pipeline: a branch that changes a manifest gets a second pass without secrets", () => {
  const second = setups(seenA).filter((s) => s.spec.stdout.endsWith("-setup-open.log"));
  expect(second).toHaveLength(1);
  expect(second[0]!.spec.cwd).toBe(checkoutOfA());
  expect(second[0]!.spec.argv.some((x) => x.endsWith("-setup-tree"))).toBe(false);
  // After the first pass and before the checks.
  const kinds = seenA
    .filter((s) => s.spec.cwd.includes(`${ID}-1`) && s.spec.stdout.includes("/verify/"))
    .map((s) => s.kind);
  expect(kinds.slice(0, 3)).toEqual(["setup", "setup", "checks"]);
});

test("pipeline: the second pass gets no plan grant and no credentials folder", () => {
  const second = setups(seenA).find((s) => s.spec.stdout.endsWith("-setup-open.log"))!;
  expect(second.spec.argv.join(" ")).not.toContain("setup-creds");
  expect(second.spec.env.NPM_CONFIG_USERCONFIG).toBeUndefined();
  expect(second.spec.env.npm_config_ignore_scripts).toBeUndefined();
});

test("pipeline: install output is copied into the checkout after a clean scan", () => {
  const checks = seenA.find((s) => s.kind === "checks")!;
  expect(checks.checkoutHas.venv).toBe(true);
});

test("pipeline: a clean checkout after setup lets the worker start", () => {
  expect(workers(a)).toHaveLength(1);
  expect(a.mission()!.waiting).not.toBe("fix repo files");
});

test("pipeline: a repo without setup secrets runs setup once", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  const seen: Seen[] = [];
  try {
    happy(p);
    p.respond.worker = reply(build(), BRANCH);
    seeing(p, seen);
    await run(p, published);
    expect(treeRuns(seen)).toEqual([]);
    const verify = setups(seen).filter((s) => s.spec.stdout.includes("/verify/"));
    expect(verify).toHaveLength(1);
    expect(verify[0]!.spec.argv.join(" ")).not.toContain("setup-");
    const cache = p.home.cache("web");
    const worker = p.claudeCalls.find((c) => c.kind === "worker")!;
    expect(
      (worker.settings.sandbox as { filesystem: { allowWrite?: string[] } }).filesystem.allowWrite,
    ).toEqual([cache]);
  } finally {
    p.cleanup();
  }
}, 60_000);

// ── A secret setup leaves behind stops the stage before the worker ────────────────────────────────────────

test("pipeline: a setup secret left in the checkout stops the stage before the worker", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  const seen: Seen[] = [];
  try {
    happy(p);
    secrets(p);
    seeing(p, seen, (spec) => {
      if (!spec.argv.some((x) => x.endsWith("-setup-tree"))) return null;
      writeFileSync(join(spec.cwd, ".npmrc-leak"), `//registry/:_authToken=${TOKEN}\n`);
      return null;
    });
    await run(p, (x) => x.mission()?.waiting === "fix repo files");
    const m = p.mission()!;
    expect(m.waiting, p.moves()).toBe("fix repo files");
    expect(m.why).toBe("setup left a secret in .npmrc-leak (NPM_TOKEN)");
    expect(m.why).not.toContain(TOKEN);
    expect(workers(p)).toHaveLength(0);
    // Nothing was copied, and the folders are gone.
    const checkout = join(p.home.root, "work", `${ID}-1`);
    expect(existsSync(join(checkout, ".venv"))).toBe(false);
    expect(existsSync(`${checkout}-setup-tree`)).toBe(false);
    expect(existsSync(`${checkout}-setup-creds`)).toBe(false);
    // The log the worker could read is redacted.
    expect(readFileSync(join(p.home.runs(ID, "build"), "build-setup.log"), "utf8")).not.toContain(TOKEN);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a scan hit copies nothing", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    secrets(p);
    seeing(p, [], (spec) => {
      if (!spec.argv.some((x) => x.endsWith("-setup-tree"))) return null;
      mkdirSync(join(spec.cwd, ".venv"), { recursive: true });
      writeFileSync(join(spec.cwd, ".venv", "pkg.txt"), "x");
      writeFileSync(join(spec.cwd, ".venv", "creds.json"), `{"token":"${encodeURIComponent(TOKEN)}"}`);
      return null;
    });
    await run(p, (x) => x.mission()?.waiting === "fix repo files");
    expect(p.mission()!.why).toBe("setup left a secret in .venv/creds.json (NPM_TOKEN)");
    expect(existsSync(join(p.home.root, "work", `${ID}-1`, ".venv"))).toBe(false);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a setup secret in the credentials folder stops the stage (flow)", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    secrets(p);
    seeing(p, [], (spec) => {
      const creds = spec.argv.find((x) => x.endsWith("-setup-creds"));
      if (!creds) return null;
      writeFileSync(join(creds, "npmrc"), `//r/:_authToken=${TOKEN}\n`);
      return null;
    });
    await run(p, (x) => x.mission()?.waiting === "fix repo files");
    expect(p.mission()!.why).toBe("setup left a secret in setup-creds/npmrc (NPM_TOKEN)");
    expect(workers(p)).toHaveLength(0);
  } finally {
    p.cleanup();
  }
}, 60_000);

// ── The file and the setup lines are checked first ────────────────────────────────────────────────────────

test("pipeline: a setup secrets file readable by others stops setup before it runs", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  const seen: Seen[] = [];
  try {
    happy(p);
    secrets(p, `NPM_TOKEN=${TOKEN}\n`, 0o644);
    seeing(p, seen);
    await run(p, (x) => x.mission()?.waiting === "fix repo files");
    const m = p.mission()!;
    expect(m.why).toBe(
      `${join(p.home.root, "setup-secrets", "web.env")} is readable by others; chmod 600 it`,
    );
    expect(setups(seen)).toEqual([]);
    expect(workers(p)).toHaveLength(0);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a setup tool with no scripts switch stops setup (flow)", async () => {
  const p = new Pipe(
    target({ "CLAUDE.md": SETUP_MD.replace("sh ci/install.sh", "cargo fetch --locked") }),
    intents(intent({ a: 5 })),
    { keep: true },
  );
  try {
    happy(p);
    secrets(p);
    const seen: Seen[] = [];
    seeing(p, seen);
    await run(p, (x) => x.mission()?.waiting === "fix repo files");
    expect(p.mission()!.why).toBe(
      "setup secrets cannot be used with cargo: its install scripts cannot be turned off",
    );
    expect(setups(seen)).toEqual([]);
  } finally {
    p.cleanup();
  }
}, 60_000);

// ── Pass 2 needs a private package: the owner is asked, not a repair round ────────────────────────────────

test("pipeline: a second pass that needs a private package asks the owner", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    p.respond.worker = reply(build(), BRANCH);
    secrets(p);
    seeing(p, [], (spec) => {
      if (!spec.stdout.endsWith("-setup-open.log")) return null;
      writeFileSync(spec.stdout, "$ sh ci/install.sh\n");
      writeFileSync(
        spec.stderr,
        "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://npm.corp.example/@corp%2fwidgets\n",
      );
      return { code: 1 };
    });
    await run(p, (x) => x.mission()?.waiting === "answer the question");
    const m = p.mission()!;
    expect(m.waiting, p.moves()).toBe("answer the question");
    expect(m.why).toContain("The change updates packages that need the private registry.");
    // No repair round: the worker ran once.
    expect(workers(p)).toHaveLength(1);
    expect(m.repairs).toBe(0);
    const q = JSON.stringify(JSON.parse(m.data).question);
    expect(q).toContain("`package.json`");
    expect(q).toContain("npm.corp.example");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a second pass that fails otherwise is red", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    p.respond.worker = reply(build(), BRANCH);
    secrets(p);
    let failed = false;
    seeing(p, [], (spec) => {
      if (failed || !spec.stdout.endsWith("-setup-open.log")) return null;
      failed = true;
      writeFileSync(spec.stdout, "$ sh ci/install.sh\n");
      writeFileSync(spec.stderr, "install failed: evil.sh exited 3\n");
      return { code: 1 };
    });
    await run(p, (x) => workers(x).length >= 2);
    expect(workers(p).length).toBeGreaterThanOrEqual(2);
    expect(p.claudeCalls.filter((c) => c.kind === "worker")[1]!.prompt).toContain(
      "install failed: evil.sh exited 3",
    );
    expect(p.mission()!.waiting).not.toBe("answer the question");
  } finally {
    p.cleanup();
  }
}, 60_000);

// ── What the repair round reads is redacted ───────────────────────────────────────────────────────────────

test("pipeline: a redacted setup log is what the repair round gets", async () => {
  const p = new Pipe(target(), intents(intent({ a: 5 })), { keep: true });
  try {
    happy(p);
    secrets(p);
    let verifyFailed = false;
    seeing(p, [], (spec) => {
      const tree = spec.argv.some((x) => x.endsWith("-setup-tree"));
      if (!tree || verifyFailed || !spec.stdout.includes("/verify/")) return null;
      verifyFailed = true;
      const basic = Buffer.from(`${USER}:${TOKEN}`).toString("base64");
      writeFileSync(
        spec.stdout,
        `$ sh ci/install.sh\nGET https://x:${encodeURIComponent(TOKEN)}@npm.corp.example/\n`,
      );
      writeFileSync(spec.stderr, `npm ERR! auth ${TOKEN} Authorization: Basic ${basic}\n`);
      return { code: 1 };
    });
    await run(p, (x) => workers(x).length >= 2);
    const repair = p.claudeCalls.filter((c) => c.kind === "worker")[1]!;
    expect(repair.prompt).toContain("[redacted]");
    expect(repair.prompt).not.toContain(TOKEN);
    expect(repair.prompt).not.toContain(encodeURIComponent(TOKEN));
    expect(repair.prompt).not.toContain(Buffer.from(`${USER}:${TOKEN}`).toString("base64"));
    expect(readFileSync(join(p.home.runs(ID, "verify"), "verify-1-setup.log"), "utf8")).not.toContain(TOKEN);
  } finally {
    p.cleanup();
  }
}, 60_000);
