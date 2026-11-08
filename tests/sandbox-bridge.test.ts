// The route every package download takes (PIP-158): the bridge started inside the real bwrap, the proxy
// variables, and a CONNECT through the bound unix socket. Skipped with the note where bwrap can't run;
// in GitHub Actions a missing bwrap fails (see sandbox-escape.test.ts).

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { proxyServer } from "../src/pipeline/proxy.ts";
import { sandboxArgv, sandboxEnv } from "../src/pipeline/sandbox.ts";
import { loadRepos, setRepo } from "../src/repos.ts";
import { shipNetwork } from "../src/ship/live.ts";
import { BWRAP_REQUIRED, bwrapUsable, escapeMode, plant, SKIP_NOTE } from "./helpers/escape.ts";
import { testConfig } from "./helpers/world.ts";

const usable = bwrapUsable();

// A tiny client run by the sandbox's own node: CONNECT through the bridge's 127.0.0.1 port, print the status line.
const CLIENT = `
const s = require("node:net").connect(3128, "127.0.0.1", () => {
  s.write("CONNECT " + process.argv[2] + " HTTP/1.1\\r\\nHost: " + process.argv[2] + "\\r\\n\\r\\n");
});
s.once("data", (d) => { console.log(String(d).split("\\r\\n")[0]); process.exit(0); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 15000);
`;

test("sandbox escape: a granted domain goes through the bridge and an ungranted one is refused", async (ctx) => {
  const mode = escapeMode(usable, BWRAP_REQUIRED);
  if (mode === "fail") throw new Error("bwrap is not usable here, and CI must have it (PIP-160)");
  if (mode === "skip") ctx.skip(SKIP_NOTE);
  const p = plant();
  const upstream = createServer((c) => c.on("error", () => {}));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  const socket = join(p.base, "proxy.sock");
  const proxy = proxyServer({
    domains: ["granted.example.com"],
    lookup: async () => ["93.184.216.34"],
    dial: () => connect({ host: "127.0.0.1", port }),
  });
  await new Promise<void>((r) => proxy.listen(socket, r));
  writeFileSync(join(p.checkout, "client.cjs"), CLIENT);
  const run = (target: string) =>
    new Promise<string>((resolve) => {
      const line = `/run/tc/node client.cjs ${target}`;
      const argv = sandboxArgv({
        checkout: p.checkout,
        home: p.home,
        cache: null,
        cacheWritable: false,
        line,
        proxy: socket,
      });
      const child = spawn(argv[0]!, argv.slice(1), { cwd: p.checkout, env: sandboxEnv(p.home, null, {}) });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        out += d;
      });
      child.on("close", () => resolve(out));
    });
  try {
    expect(await run("granted.example.com:443")).toContain("200 Connection Established");
    expect(await run("evil.example.net:443")).toContain("403");
    expect(await run("granted.example.com:22")).toContain("403");
  } finally {
    proxy.close();
    upstream.close();
    p.cleanup();
  }
}, 120_000);

test("sandbox: ship commands reach the platform domains the owner approved", () => {
  const db = Db.memory();
  const config = testConfig({ repos: { web: { github: "owner/web" } } });
  loadRepos(config, db, 1_000);
  expect(shipNetwork(db, "web")).toEqual([]);
  setRepo(db, config, "web", ["ship_network=api.fly.io, *.vercel.com"]);
  expect(shipNetwork(db, "web")).toEqual(["api.fly.io", "*.vercel.com"]);
  // An invalid domain changes nothing, and the list is per repo.
  expect(() => setRepo(db, config, "web", ["workers=2", "ship_network=*"])).toThrow(
    "ship_network: * it would open the whole internet",
  );
  expect(shipNetwork(db, "web")).toEqual(["api.fly.io", "*.vercel.com"]);
  expect(shipNetwork(db, "api")).toEqual([]);
  setRepo(db, config, "web", ["ship_network="]);
  expect(shipNetwork(db, "web")).toEqual([]);
});
