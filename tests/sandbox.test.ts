// The sandbox is fixed in code (PIP-157..159, PIP-161..164): no setting, repo file or intent loosens it, the
// network is an allowlist proxy, a repo's commands see no credential, and a sandbox that can't start is a fault.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type ClaudeRun, claudeEnv, claudeSettings } from "../src/claude.ts";
import { doctor } from "../src/doctor.ts";
import { classifyRun, fixFor } from "../src/faults.ts";
import { grantsFor } from "../src/pipeline/access.ts";
import { domainMatches, invalidDomain, splitDomains } from "../src/pipeline/domains.ts";
import { apparmorProfile, sandboxProbe, userNamespaceDenied } from "../src/pipeline/probe.ts";
import { checkTarget, privateAddress, proxyServer, proxySocket } from "../src/pipeline/proxy.ts";
import {
  allowedRepoEnv,
  cacheEnv,
  DEFAULT_NETWORK,
  envRefusal,
  refusedRepoEnv,
  sandboxArgv,
  sandboxEnv,
} from "../src/pipeline/sandbox.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { tempDir, testConfig, testHome } from "./helpers/world.ts";

const base = {
  checkout: "/h/work/1",
  home: "/home/me",
  cache: "/h/cache/web",
  cacheWritable: false,
  line: "npm test",
};

const O = { towercabExe: "/opt/towercab/bin/towercab", home: "/home/me" };

function claudeRun(config: ReturnType<typeof testConfig>): ClaudeRun {
  return {
    kind: "worker",
    model: "opus",
    cwd: "/h/work/1",
    runsDir: "/h/runs/1",
    n: 1,
    prompt: "",
    session: { mode: "new", id: "u" },
    claudeMd: "",
    grants: { domains: [...DEFAULT_NETWORK], paths: [] },
    cacheEnv: cacheEnv("/h/cache/web", config.repos.get("web") ?? null),
    config,
  } as ClaudeRun;
}

// -- PIP-157 ----------------------------------------------------------------------------------------------

test("sandbox: config keys do not change the argv", () => {
  const plain = testConfig({ repos: { web: { github: "o/web" } } }, "/cfg/config.toml");
  const loud = testConfig(
    {
      agent: {
        path: "/evil/bin:/usr/bin",
        toolchain: ["/opt/secret-tools"],
        env: { EXTRA: "1", HTTPS_PROXY: "http://evil" },
        network: ["*"],
        sandbox_unix_sockets: true,
      },
      repos: { web: { github: "o/web" } },
    },
    "/cfg/config.toml",
  );
  // The builder takes the mission's facts only; the environment, the Claude env and its settings are the same.
  expect(sandboxEnv("/home/me", loud, {})).toEqual(sandboxEnv("/home/me", plain, {}));
  expect(claudeEnv(claudeRun(loud), "/home/me")).toEqual(claudeEnv(claudeRun(plain), "/home/me"));
  expect(claudeSettings(claudeRun(loud), O)).toEqual(claudeSettings(claudeRun(plain), O));
  expect(sandboxArgv(base).join(" ")).not.toContain("secret-tools");
  expect(sandboxEnv("/home/me", loud, {}).PATH).not.toContain("/evil");
});

test("sandbox: repo and intent files do not change the argv", () => {
  // An intent's `network` and `unlock` and a plan's grants can add a domain or a protected path, never a
  // wildcard, an IP address or a mount: the argv is built from the checkout, the cache and the proxy socket.
  const g = grantsFor({
    a: 3,
    source: "me",
    plan: { domains: [{ domain: "*", why: "all" }], paths: [], tests: [] },
    unlock: ["/etc/**"],
    network: ["10.0.0.1", "*.com", "api.example.com"],
    defaults: [...DEFAULT_NETWORK],
    unplanned: null,
  });
  expect(g.domains).toContain("api.example.com");
  expect(g.domains).not.toContain("*");
  expect(g.domains).not.toContain("10.0.0.1");
  expect(g.domains).not.toContain("*.com");
  const argv = sandboxArgv({ ...base, proxy: "/tmp/p.sock" });
  expect(argv.filter((a) => a === "--bind" || a === "--ro-bind" || a === "--ro-bind-try").length).toBe(
    sandboxArgv({ ...base, proxy: "/tmp/p.sock", line: "other" }).filter(
      (a) => a === "--bind" || a === "--ro-bind" || a === "--ro-bind-try",
    ).length,
  );
});

test("sandbox: no unsafe switch exists", () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      if (statSync(p).isDirectory()) return f === "node_modules" ? [] : walk(p);
      return p.endsWith(".ts") ? [p] : [];
    });
  for (const f of walk("src")) {
    const text = readFileSync(f, "utf8");
    expect(text, f).not.toMatch(
      /--share-net|allowUnsandboxedCommands:\s*true|dangerouslyDisableSandbox|TOWERCAB_UNSAFE|--unsafe/,
    );
  }
  expect(sandboxArgv(base)).toContain("--unshare-net");
  expect(sandboxArgv({ ...base, proxy: "/tmp/p.sock" })).toContain("--unshare-net");
});

test("sandbox: ignored config keys are named by doctor", async () => {
  const config = testConfig({
    agent: { toolchain: ["/opt/x"], env: { A: "1" }, network: ["example.com"] },
    repos: { web: { github: "o/web", env: { GH_TOKEN: "x", FINE: "1" } } },
  });
  const r = await doctor({ config, home: testHome(), tools: new FakeTools(), github: null, quick: true });
  expect(r.lines).toContain("config: [agent] toolchain is ignored: the sandbox's settings are fixed in code");
  expect(r.lines).toContain("config: [agent] env is ignored: the sandbox's settings are fixed in code");
  expect(r.lines).toContain("config: [agent] network is ignored: the sandbox's settings are fixed in code");
  expect(r.lines.some((l) => /^web: env GH_TOKEN is left out of the sandbox: /.test(l))).toBe(true);
  expect(r.lines.some((l) => l.includes("env FINE"))).toBe(false);
});

// -- PIP-158 ----------------------------------------------------------------------------------------------

test("sandbox: network is always unshared", () => {
  for (const proxy of [null, undefined, "/tmp/p.sock"]) {
    for (const cacheWritable of [false, true]) {
      const argv = sandboxArgv({ ...base, proxy, cacheWritable });
      expect(argv[1]).toBe("--unshare-net");
      expect(argv.filter((a) => a === "--unshare-net")).toHaveLength(1);
      expect(argv).not.toContain("--share-net");
    }
  }
});

const PUBLIC = "93.184.216.34";

async function viaProxy(
  domains: string[],
  lookup: (h: string) => Promise<string[]>,
  how: (socket: string) => Promise<{ status: number; body: string }>,
): Promise<{ status: number; body: string; logs: string[]; hits: number }> {
  const logs: string[] = [];
  let hits = 0;
  const upstream = createServer((c) => {
    hits++;
    c.once("data", () => c.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi"));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  const socket = join(tempDir(), "p.sock");
  const server = proxyServer({
    domains,
    lookup,
    dial: () => connect({ host: "127.0.0.1", port }),
    log: (l) => logs.push(l),
  });
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    const res = await how(socket);
    return { ...res, logs, hits };
  } finally {
    server.close();
    upstream.close();
  }
}

const get = (host: string) => (socket: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: socket, path: `http://${host}/x`, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

const connectTo = (target: string) => (socket: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: socket, method: "CONNECT", path: target });
    req.on("connect", (res, sock) => {
      sock.destroy();
      resolve({ status: res.statusCode ?? 0, body: "" });
    });
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, body: "" }));
    req.on("error", reject);
    req.end();
  });

test("sandbox: the proxy allows a granted domain", async () => {
  const lookup = async () => [PUBLIC];
  const plain = await viaProxy(["*.example.com"], lookup, get("cdn.example.com"));
  expect([plain.status, plain.body, plain.hits]).toEqual([200, "hi", 1]);
  const tunnel = await viaProxy(["registry.npmjs.org"], lookup, connectTo("registry.npmjs.org:443"));
  expect(tunnel.status).toBe(200);
  expect(domainMatches("*.example.com", "a.b.example.com")).toBe(true);
  expect(domainMatches("*.example.com", "example.com")).toBe(false);
});

test("sandbox: the proxy refuses a domain that is not granted", async () => {
  const lookup = async () => [PUBLIC];
  const r = await viaProxy(["example.com"], lookup, get("evil.test"));
  expect([r.status, r.hits]).toEqual([403, 0]);
  expect(r.logs.join("\n")).toContain("evil.test is not granted");
  const t = await viaProxy(["example.com"], lookup, connectTo("evil.test:443"));
  expect([t.status, t.hits]).toEqual([403, 0]);
  const port = await viaProxy(["example.com"], lookup, connectTo("example.com:22"));
  expect([port.status, port.hits]).toEqual([403, 0]);
  expect(port.logs.join("\n")).toContain("port 22");
});

test("sandbox: the proxy refuses IP literals and private addresses", async () => {
  const o = { domains: ["example.com", "*.example.com"], lookup: async () => ["10.1.2.3"] };
  expect(await checkTarget({ ...o }, "93.184.216.34", 443)).toEqual({
    refuse: "93.184.216.34 is an IP address",
  });
  expect(await checkTarget({ ...o }, "[::1]", 443)).toEqual({ refuse: "[::1] is an IP address" });
  // A granted name that resolves inside, or only partly outside, is refused.
  expect(await checkTarget(o, "example.com", 443)).toEqual({
    refuse: "example.com resolves to a private address (10.1.2.3)",
  });
  expect(
    await checkTarget({ ...o, lookup: async () => [PUBLIC, "127.0.0.1"] }, "a.example.com", 443),
  ).toEqual({
    refuse: "a.example.com resolves to a private address (127.0.0.1)",
  });
  expect(await checkTarget({ ...o, lookup: async () => [PUBLIC] }, "example.com", 443)).toEqual({
    address: PUBLIC,
  });
  for (const a of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "0.0.0.0",
  ]) {
    expect(privateAddress(a), a).toBe(true);
  }
  for (const a of [PUBLIC, "8.8.8.8", "2606:4700::1111"]) expect(privateAddress(a), a).toBe(false);
});

test("sandbox: no grant binds no proxy", () => {
  expect(proxySocket([])).toBeNull();
  expect(proxySocket(["", "  "])).toBeNull();
  const sock = proxySocket(["pkg.example.com"]);
  expect(sock).toMatch(/\.sock$/);
  // The same set shares a socket, in any order.
  expect(proxySocket(["pkg.example.com"])).toBe(sock);
  const argv = sandboxArgv({ ...base, proxy: null });
  expect(argv.join(" ")).not.toContain("/run/tc");
  expect(argv.at(-1)).toBe("npm test");
});

// -- PIP-159 ----------------------------------------------------------------------------------------------

test("sandbox: the environment is built from an allowlist", () => {
  const env = sandboxEnv("/home/me", null, cacheEnv("/h/cache/web", null));
  expect(Object.keys(env).sort()).toEqual(
    [
      "CARGO_HOME",
      "CARGO_TARGET_DIR",
      "GOCACHE",
      "HOME",
      "LANG",
      "PATH",
      "PIP_CACHE_DIR",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "npm_config_cache",
    ].sort(),
  );
  // Nothing of Towercab's own environment passes.
  process.env.GH_TOKEN = "ghp_hostcanary0000000000000000";
  try {
    expect(JSON.stringify(sandboxEnv("/home/me", null, {}))).not.toContain("hostcanary");
    expect(JSON.stringify(claudeEnv(claudeRun(testConfig()), "/home/me"))).not.toContain("hostcanary");
  } finally {
    delete process.env.GH_TOKEN;
  }
});

test("sandbox: a token-like repo variable name is left out", () => {
  const env = {
    GH_TOKEN: "x",
    NPM_AUTH: "x",
    MY_API_KEY: "x",
    DEPLOY_PASSWORD: "x",
    client_secret: "x",
    CARGO_TARGET_DIR: "/t",
  };
  expect(allowedRepoEnv(env)).toEqual({ CARGO_TARGET_DIR: "/t" });
  expect(envRefusal("MY_API_KEY", "x")).toMatch(/token, key, secret/);
  expect(refusedRepoEnv(env).map((r) => r.name)).toEqual([
    "GH_TOKEN",
    "NPM_AUTH",
    "MY_API_KEY",
    "DEPLOY_PASSWORD",
    "client_secret",
  ]);
});

test("sandbox: a secret-looking repo variable value is left out", () => {
  for (const v of [
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "sk-ant-api03-abcdefghij",
    `${"AKIA"}ABCDEFGHIJKLMNOP`,
    "xoxb-1234567890-abcdef",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ]) {
    expect(envRefusal("SOME_SETTING", v), v).toBe("the value looks like a secret");
  }
  expect(allowedRepoEnv({ SOME_SETTING: "ghp_abcdefghijklmnopqrstuvwxyz0123" })).toEqual({});
});

test("sandbox: a repo variable that fits the rule passes", () => {
  const env = {
    CARGO_TARGET_DIR: "/t",
    RUST_LOG: "debug",
    CI: "1",
    NODE_OPTIONS: "--max-old-space-size=4096",
  };
  expect(allowedRepoEnv(env)).toEqual(env);
  expect(cacheEnv("/c", { env } as never)).toMatchObject(env);
  // The repo's own value wins over the cache's default for the same name.
  expect(cacheEnv("/c", { env: { GOCACHE: "/mine" } } as never).GOCACHE).toBe("/mine");
});

test("sandbox: PATH and HOME cannot be set by a repo", () => {
  for (const name of [
    "PATH",
    "HOME",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "SOPS_AGE_FILE",
    "AGE_X",
    "HTTP_PROXY",
    "https_proxy",
    "TMPDIR",
    "LANG",
  ]) {
    expect(envRefusal(name, "/x"), name).not.toBeNull();
  }
  const sb = sandboxEnv("/home/me", null, cacheEnv("/c", { env: { PATH: "/evil", HOME: "/evil" } } as never));
  expect(sb.PATH).not.toContain("/evil");
  expect(sb.HOME).toBe("/home/me");
});

// -- PIP-161 ----------------------------------------------------------------------------------------------

test("sandbox: a missing bwrap is a fault, not a run", async () => {
  const tools = new FakeTools();
  tools.present.delete("bwrap");
  const r = await sandboxProbe(tools);
  expect(r).toEqual({ ok: false, why: "bwrap is not installed" });
  // Nothing ran: no bwrap call, and so no unsandboxed one.
  expect(tools.calls).toEqual([]);
});

test("sandbox: a refused namespace is a fault, not a repair", async () => {
  const text = "bwrap: setting up uid map: Permission denied";
  expect(classifyRun(`$ npm test\n${text}`)).toMatchObject({ kind: "sandbox" });
  expect(classifyRun("bwrap: No permissions to create new namespace")).toMatchObject({ kind: "sandbox" });
  const tools = new FakeTools().on("/usr/bin/bwrap", () => failResult(text, 1));
  const r = await sandboxProbe(tools);
  expect(r.ok).toBe(false);
  expect(r.why).toContain("the sandbox can't start");
  expect(userNamespaceDenied(r.why)).toBe(true);
});

test("sandbox: no path runs a command unsandboxed", async () => {
  // Every argv the builder returns is a bwrap run that unshares the network, with or without a proxy; the
  // probe runs nothing when bwrap fails; and no source file builds an `sh -c` for a repo's line outside it.
  for (const proxy of [null, "/tmp/p.sock"]) {
    const argv = sandboxArgv({ ...base, proxy });
    expect(argv[0]).toBe("bwrap");
    expect(argv.indexOf("--")).toBeGreaterThan(argv.indexOf("--unshare-net"));
  }
  const tools = new FakeTools().on("/usr/bin/bwrap", () => failResult("bwrap: boom", 1));
  expect((await sandboxProbe(tools)).ok).toBe(false);
  expect(tools.calls.map((c) => c.cmd)).toEqual(["/usr/bin/bwrap"]);
});

test("sandbox: the fault text names no setting that loosens the sandbox", () => {
  const text = fixFor("sandbox");
  expect(text).not.toMatch(
    /sandbox_unix_sockets|apparmor_restrict_unprivileged_userns|= true|unprivileged_userns_clone/,
  );
  expect(text).toContain("AppArmor profile");
});

// -- PIP-162, PIP-163 -------------------------------------------------------------------------------------

test("sandbox: a restricted user namespace gives the apparmor profile fix", async () => {
  const tools = new FakeTools().on("/usr/bin/bwrap", (args) =>
    args[0] === "--version"
      ? okResult("bubblewrap 0.9.0")
      : failResult("bwrap: setting up uid map: Permission denied"),
  );
  const r = await doctor({
    config: testConfig(),
    home: testHome(),
    tools,
    github: null,
    quick: false,
  });
  expect(r.ok).toBe(false);
  const text = r.lines.join("\n");
  expect(text).toContain("sandbox: the probe failed: the sandbox can't start");
  expect(text).toContain("profile towercab-bwrap /usr/bin/bwrap flags=(unconfined) {");
  expect(text).toContain("userns,");
  expect(apparmorProfile("/usr/bin/bwrap").join("\n")).toContain("apparmor_parser -r");
});

test("sandbox: doctor never suggests turning the restriction off", async () => {
  const tools = new FakeTools().on("/usr/bin/bwrap", () =>
    failResult("bwrap: setting up uid map: Permission denied"),
  );
  const r = await doctor({ config: testConfig(), home: testHome(), tools, github: null, quick: false });
  const text = `${r.lines.join("\n")}\n${apparmorProfile("/usr/bin/bwrap").join("\n")}\n${fixFor("sandbox")}`;
  expect(text).not.toMatch(/sysctl|apparmor_restrict_unprivileged_userns|unprivileged_userns_clone|=\s*0/);
});

test("sandbox: the start probe passes on a sound sandbox", async () => {
  const tools = new FakeTools().on("/usr/bin/bwrap", (args) => {
    // The probe runs the production argv: the network unshared, a checkout with .git, the script last.
    expect(args[0]).toBe("--unshare-net");
    expect(args.at(-1)).toContain(".ssh/canary");
    return okResult("held\n");
  });
  expect(await sandboxProbe(tools)).toEqual({ ok: true, why: "held" });
  // Each way it can fail says what it found.
  for (const [code, why] of [
    [21, "a secret outside the checkout could be read"],
    [22, "the checkout's .git could be written"],
    [23, "the sandbox has a network interface without a grant"],
  ] as const) {
    const t = new FakeTools().on("/usr/bin/bwrap", () => failResult("", code));
    expect(await sandboxProbe(t)).toEqual({ ok: false, why });
  }
});

// -- PIP-164 ----------------------------------------------------------------------------------------------

test("sandbox: a wildcard or TLD grant is refused", () => {
  expect(invalidDomain("*")).toMatch(/whole internet/);
  expect(invalidDomain("*.com")).not.toBeNull();
  expect(invalidDomain("com")).not.toBeNull();
  expect(invalidDomain("api.*.com")).not.toBeNull();
  expect(invalidDomain("https://example.com")).toMatch(/URL/);
  expect(invalidDomain("example.com:8080")).toMatch(/port/);
  expect(invalidDomain("exa mple.com")).not.toBeNull();
  for (const ok of ["example.com", "*.example.com", "registry.npmjs.org", "a-b.example.co.uk"]) {
    expect(invalidDomain(ok), ok).toBeNull();
  }
  expect(splitDomains(["example.com", "*", "*.org"])).toEqual({
    valid: ["example.com"],
    invalid: [
      { domain: "*", why: "it would open the whole internet" },
      { domain: "*.org", why: "it is a bare top-level name, not a domain" },
    ],
  });
});

test("sandbox: an IP literal grant is refused", () => {
  for (const ip of ["1.2.3.4", "10.0.0.1", "::1", "[::1]", "2606:4700::1111", "*.1.2.3.4"]) {
    expect(invalidDomain(ip), ip).not.toBeNull();
  }
});

test("sandbox: a path grant does not widen the mounts", () => {
  // Protected paths are checkout globs the guard and Claude's settings know; the sandbox's mounts are the
  // same whatever a plan grants, and `.git` stays read-only.
  const wide = grantsFor({
    a: 4,
    source: "me",
    plan: {
      domains: [],
      paths: [
        { glob: "/etc/**", why: "x" },
        { glob: ".git/**", why: "y" },
      ],
      tests: [],
    },
    unlock: [],
    network: [],
    defaults: [],
    unplanned: null,
  });
  expect(wide.paths).toContain("/etc/**");
  expect(sandboxArgv(base)).toEqual(sandboxArgv({ ...base }));
  const argv = sandboxArgv(base);
  const git = argv.indexOf("--ro-bind-try");
  expect(argv.slice(git, git + 3)).toEqual(["--ro-bind-try", "/h/work/1/.git", "/h/work/1/.git"]);
  expect(argv.filter((a) => a === "/etc" || a === "/etc/**")).toEqual([]);
});

test("sandbox: a failed probe stops the loop taking missions", async () => {
  const { Pipe } = await import("./helpers/pipe.ts");
  const { happy, intent, intents, TARGET } = await import("./helpers/flows.ts");
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    const loop = await p.start();
    let ok = false;
    const calls: number[] = [];
    Object.assign(loop.d, {
      sandboxProbe: async () => {
        calls.push(1);
        return ok ? { ok: true, why: "held" } : { ok: false, why: "the sandbox can't start: boom" };
      },
    });
    await loop.pass();
    await loop.pass();
    // A sandbox fault is open: nothing was picked, and the probe is not hammered (once a minute).
    expect(p.mission()).toBeUndefined();
    expect(loop.health.open().map((f) => f.kind)).toEqual(["sandbox"]);
    expect(calls).toHaveLength(1);
    // A minute later it passes, the fault clears, and the intent is picked.
    ok = true;
    p.clock.advance(61);
    await loop.pass();
    expect(loop.health.open()).toEqual([]);
    await p.until(() => p.mission() !== undefined);
    expect(p.mission()).toBeDefined();
  } finally {
    p.cleanup();
  }
}, 60_000);

test("sandbox: a plan's domains reach commands too", async () => {
  const { commandDomains } = await import("../src/pipeline/checks.ts");
  const m = (data: object) => ({ data: JSON.stringify(data) }) as Parameters<typeof commandDomains>[0];
  expect(commandDomains(m({}))).toEqual([...DEFAULT_NETWORK]);
  // Ticked in the plan, or allowed by the owner mid-build; an invalid one never gets in.
  expect(
    commandDomains(
      m({
        granted: { domains: [{ domain: "api.example.com" }, { domain: "*" }] },
        unplanned: { domains: [{ domain: "fonts.example.org" }, { domain: "10.0.0.1" }] },
      }),
    ),
  ).toEqual([...DEFAULT_NETWORK, "api.example.com", "fonts.example.org"]);
});

test("sandbox: the ship stage reaches the live app's host", async () => {
  const { liveDomains } = await import("../src/ship/live.ts");
  expect(liveDomains({ url: "https://app.example.com/path" })).toEqual(["app.example.com"]);
  expect(liveDomains({ url: "https://app.example.com:8443" })).toEqual(["app.example.com"]);
  expect(liveDomains({ url: "not a url" })).toEqual([]);
  // A host that is an IP address or a bare name is no grant (PIP-164), so the proxy never gets it.
  expect(splitDomains(liveDomains({ url: "http://10.0.0.5" })).valid).toEqual([]);
  expect(splitDomains(liveDomains({ url: "http://localhost:3000" })).valid).toEqual([]);
});
