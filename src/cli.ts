// The command line (LOOP-15): `towercab [--config <file>] [--home <dir>] <command>`.
// Errors print `towercab: <reason>` and exit 1; bad arguments exit 2.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyCommand, type CommandName, commandResult, insertCommand, pendingCommands } from "./commands.ts";
import { appKeyPath, type Config, ConfigError, checkLoop, configPath, loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { doctor } from "./doctor.ts";
import { createGitHub } from "./github/gh.ts";
import { approve as ownerApprove } from "./github/owner.ts";
import type { GitHub } from "./handlers.ts";
import { systemClock } from "./handlers.ts";
import { Home } from "./home.ts";
import { openStore } from "./intents/store.ts";
import type { IntentStore } from "./intents/types.ts";
import * as log from "./log.ts";
import { Loop } from "./loop.ts";
import { type ApplyCtx, isWait } from "./machine.ts";
import { type Mission, unfinishedFor } from "./mission.ts";
import { decide, nextText } from "./pick.ts";
import { guardMain } from "./pipeline/guard.ts";
import { handlers } from "./pipeline/index.ts";
import { parseScores } from "./priority.ts";
import { addRepo, loadRepos, removeRepo, repoLine, repoList, setRepo } from "./repos.ts";
import { checkoutRoot, down, logsArgv, restart, up } from "./service.ts";
import { renderStatus } from "./status.ts";
import { Telegram } from "./telegram.ts";
import { realTools, type Tools } from "./tools.ts";
import { checkUpdate, version } from "./update.ts";

export const COMMANDS = [
  "up",
  "down",
  "restart",
  "logs",
  "run",
  "status",
  "next",
  "add",
  "answer",
  "retry",
  "drop",
  "start",
  "approve",
  "pause",
  "resume",
  "ui",
  "doctor",
  "update",
  "repo",
  "hook",
] as const;

const USAGE = `usage: towercab [--config <file>] [--home <dir>] <command>

  up | down | restart | logs      the systemd user service
  run [--watch] [--intent <id>]   the loop in the foreground
  status | next                   what is happening, and what runs next
  add "<repo>: <title>" [uN iN aN]
  answer <id> <text>              answer a question (when there is no PR to reply on)
  answer <id> allow <path>…       allow a test you refused earlier, for the running mission
  approve <id>                    merge the PR the intent waits on, as you
  retry <id> | drop <id>
  start <id>                      begin that intent's design now, even when the repo is full
  pause | resume
  repo add <owner/name> [--name <short>] | repo remove <name> | repo list
  repo set <name> key=value…      workers, ahead, base, path, env (NAME=value or a JSON object)
  ui [--no-open]                  open the web page
  doctor [--quick]                what is missing
  update                          update this checkout to the latest main now
`;

class UsageError extends Error {}

function pkgVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(checkoutRoot(), "package.json"), "utf8")) as { version: string })
      .version;
  } catch {
    return "unknown";
  }
}

interface World {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  github: GitHub | null;
  store(): Promise<IntentStore>;
}

function world(flags: { config?: string; home?: string }, tools: Tools): World {
  const config = loadConfig(configPath(flags.config));
  const home = Home.resolve(flags.home);
  const db = Db.openHome(home.db);
  loadRepos(config, db, Date.now() / 1000);
  const github = config.github ? createGitHub({ config, tools, db, keyPath: appKeyPath(config) }) : null;
  let store: Promise<IntentStore> | null = null;
  return {
    config,
    home,
    db,
    tools,
    github,
    store: () => {
      if (!store) {
        const gh = github;
        const intentsGithub = /github\.com[/:]([^/]+\/[^/.]+)/.exec(config.intents.remote)?.[1] ?? null;
        store = openStore({
          remote: config.intents.remote,
          path: config.intents.path ?? home.intents,
          tools,
          auth:
            gh && intentsGithub && existsSync(appKeyPath(config))
              ? () => gh.gitAuth(intentsGithub)
              : undefined,
          cutoff: config.intents.cutoff,
          log: (t) => log.emit(t),
        });
      }
      return store;
    },
  };
}

function applyCtx(db: Db): ApplyCtx {
  return {
    db,
    now: Date.now() / 1000,
    subject: (m: Mission) => ({ title: m.intent, repo: m.repo, link: null }),
    log: (l) => log.emit(l),
  };
}

/** Queue a command for the loop, or apply it here when no loop runs (LOOP-15). */
async function submit(w: World, name: CommandName, arg = "", text = ""): Promise<string> {
  const id = insertCommand(w.db, { name, arg, text, source: "cli" }, Date.now() / 1000);
  if (w.home.holder() === null) {
    const store = await w.store();
    const row = pendingCommands(w.db).find((r) => r.id === id)!;
    return applyCommand({ db: w.db, store, applyCtx: applyCtx(w.db), now: new Date() }, row);
  }
  for (let i = 0; i < 20; i++) {
    const r = commandResult(w.db, id);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  return "queued: the loop applies it on its next pass";
}

export async function main(argv: string[], tools: Tools = realTools()): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        home: { type: "string" },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        watch: { type: "boolean" },
        intent: { type: "string" },
        "no-open": { type: "boolean" },
        quick: { type: "boolean" },
        name: { type: "string" },
      },
    });
  } catch (e) {
    process.stderr.write(`towercab: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values: v, positionals: p } = parsed;
  if (v.version) {
    process.stdout.write(`towercab ${pkgVersion()}\n`);
    return 0;
  }
  const [cmd, ...args] = p;
  if (v.help || !cmd) {
    process.stdout.write(USAGE);
    return cmd || v.help ? 0 : 2;
  }
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    process.stderr.write(`towercab: unknown command ${cmd}\n${USAGE}`);
    return 2;
  }
  const flags = { config: v.config as string | undefined, home: v.home as string | undefined };
  try {
    const out = await run(cmd as (typeof COMMANDS)[number], args, v as Record<string, unknown>, flags, tools);
    if (typeof out === "number") return out;
    if (out) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`towercab: ${e.message}\n${USAGE}`);
      return 2;
    }
    process.stderr.write(`towercab: ${(e as Error).message}\n`);
    return 1;
  }
}

async function run(
  cmd: (typeof COMMANDS)[number],
  args: string[],
  v: Record<string, unknown>,
  flags: { config?: string; home?: string },
  tools: Tools,
): Promise<string | number> {
  const need = (n: number, what: string) => {
    if (args.length < n) throw new UsageError(`${cmd} needs ${what}`);
  };
  switch (cmd) {
    case "hook": {
      if (args[0] !== "guard" || !args[1]) throw new UsageError("hook guard <rules>");
      return guardMain([args[1]]);
    }
    case "up":
      checkLoop(world(flags, tools).config);
      return up(tools);
    case "down":
      return down(tools);
    case "restart":
      return restart(tools);
    case "logs": {
      const [c, ...a] = logsArgv();
      const { spawnSync } = await import("node:child_process");
      return spawnSync(c!, a, { stdio: "inherit" }).status ?? 1;
    }
    case "doctor": {
      if (v.quick) {
        // The self-update check runs the new code before it is accepted: it must not touch the
        // database (no migration, no import), so a rejected update leaves it as it was (LOOP-35).
        let config: Config;
        try {
          config = loadConfig(configPath(flags.config));
        } catch (e) {
          if (e instanceof ConfigError) return `config: ${e.message}`;
          throw e;
        }
        const r = await doctor({ config, home: Home.resolve(flags.home), tools, github: null, quick: true });
        process.stdout.write(`${r.lines.join("\n")}\n`);
        return r.ok ? 0 : 1;
      }
      let w: World;
      try {
        w = world(flags, tools);
      } catch (e) {
        if (e instanceof ConfigError) return `config: ${e.message}`;
        throw e;
      }
      const r = await doctor({
        config: w.config,
        home: w.home,
        tools,
        github: w.github,
        quick: Boolean(v.quick),
        db: w.db,
      });
      process.stdout.write(`${r.lines.join("\n")}\n`);
      return r.ok ? 0 : 1;
    }
    case "update": {
      const r = await checkUpdate({ tools, checkout: checkoutRoot(), idle: () => true });
      if (r.kind === "updated") return `updated ${r.from} → ${r.to}; run towercab restart to use it`;
      if (r.kind === "failed") throw new Error(`update failed and rolled back: ${r.why}`);
      return r.kind === "none" ? `nothing to update: ${r.why}` : "waiting";
    }
    default:
      break;
  }

  const w = world(flags, tools);
  switch (cmd) {
    case "run": {
      checkLoop(w.config);
      const lock = w.home.lock();
      log.init(w.home.logFile);
      const store = await w.store();
      const loop = new Loop(
        {
          config: w.config,
          home: w.home,
          db: w.db,
          tools,
          clock: systemClock,
          store,
          github: w.github!,
          handlers: handlers(),
          log: (l) => log.emit(l),
          sender: w.config.telegram ? new Telegram(w.config.telegram) : null,
          selfUpdate: Boolean(v.watch),
          readiness: true,
        },
        { watch: Boolean(v.watch), intent: v.intent as string | undefined },
      );
      const stop = () => loop.stop(0);
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      const ui = v.watch && w.config.ui.port ? await startUiFor(loop, w) : null;
      try {
        return await loop.run();
      } finally {
        ui?.stop();
        lock.release();
      }
    }
    case "status":
    case "next": {
      const store = await w.store();
      let listing = null;
      let listingError: string | null = null;
      try {
        listing = await store.list();
      } catch (e) {
        listingError = (e as Error).message;
      }
      const dummy = new Loop(
        {
          config: w.config,
          home: w.home,
          db: w.db,
          tools,
          clock: systemClock,
          store,
          github: w.github!,
          handlers: {},
          log: () => {},
          sender: null,
        },
        { watch: false },
      );
      const decision = listing ? decide(listing, dummy.pickState()) : null;
      const next =
        decision && listing ? nextText(decision, listing, w.config.intents.cutoff) : `next: ${listingError}`;
      if (cmd === "next") return next;
      const ver = await version({ tools, checkout: checkoutRoot() });
      return renderStatus({
        db: w.db,
        listing,
        listingError,
        running: w.home.holder(),
        version: `${pkgVersion()} (${ver.commit}${ver.behind ? `, ${ver.behind} behind main` : ""})`,
        now: Date.now() / 1000,
        problems: JSON.parse(w.db.meta("health") ?? "[]"),
        next: next.split("\n")[0]!,
        waits: next
          .split("\n")
          .filter((l) => / intents ahead \(start /.test(l) || / repo not ready: /.test(l))
          .map((l) => l.replace(/^skipped: /, "")),
        prLink: (m) => dummy.subject(m).link,
        queued: dummy.queued(),
      });
    }
    case "add": {
      need(1, `"<repo>: <title>"`);
      const m = /^([A-Za-z0-9._-]+):\s*(.+)$/.exec(args[0]!.trim());
      if (!m) throw new UsageError(`want "<repo>: <title>", got "${args[0]}"`);
      const scores = parseScores(args.slice(1));
      const store = await w.store();
      const i = await store.add({ repo: m[1]!, title: m[2]!.trim(), ...scores }, new Date());
      return `${i.id} ${i.dir}/intent.md`;
    }
    case "answer":
      need(2, "<id> <text>");
      return submit(w, "answer", args[0], args.slice(1).join(" "));
    case "retry":
      need(1, "<id>");
      return submit(w, "retry", args[0]);
    case "drop":
      need(1, "<id>");
      return submit(w, "drop", args[0]);
    case "start":
      need(1, "<id>");
      return submit(w, "start", args[0]);
    case "pause":
      return submit(w, "pause");
    case "resume":
      return submit(w, "resume");
    case "approve": {
      need(1, "<id>");
      const store = await w.store();
      const intent = await store.get(args[0]!);
      const m = unfinishedFor(w.db, intent.id);
      if (!m || !isWait(m.stage) || m.stage === "blocked") {
        throw new Error(
          `${intent.id} isn't waiting for a merge${m?.stage === "blocked" ? ": answer its question instead" : ""}`,
        );
      }
      const repo = w.config.repos.get(m.repo);
      if (!repo || !w.github) throw new Error(`unknown repo ${m.repo}`);
      const [gh, n] =
        m.stage === "approval:plan"
          ? [store.github()!, m.plan_pr!]
          : m.stage === "approval:spec"
            ? [repo.github, m.spec_pr!]
            : [repo.github, m.pr!];
      await ownerApprove(w.github, gh, n);
      return `merged ${gh}#${n} as ${w.config.github?.me}; Towercab continues on its next read`;
    }
    case "repo":
      return repo(w, args, v.name as string | undefined);
    case "ui": {
      if (!w.config.ui.port) throw new Error("ui is off: [ui] port = 0");
      const url = `http://localhost:${w.config.ui.port}/`;
      if (w.home.holder() !== null) {
        if (!v["no-open"]) await tools.run("xdg-open", [url], { timeoutMs: 10_000 });
        return url;
      }
      // No loop: serve the same page read-only until Ctrl-C (UI-2).
      const { serveReadOnly } = await import("./ui/wire.ts");
      const server = await serveReadOnly(w.config, w.home, w.db, await w.store(), tools);
      const at = server.url() ?? url;
      process.stdout.write(`${at} (read-only: towercab isn't running)\n`);
      if (!v["no-open"]) await tools.run("xdg-open", [at], { timeoutMs: 10_000 });
      await new Promise<void>((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
      await server.stop();
      return 0;
    }
    default:
      return 0;
  }
}

const REPO_USAGE =
  "repo add <owner/name> [--name <short>] | repo remove <name> | repo set <name> key=value… | repo list";

/** `repo add | remove | set | list` (LOOP-66, LOOP-67, LOOP-69); a running loop sees the change on its next pass. */
async function repo(w: World, args: string[], name: string | undefined): Promise<string> {
  const [sub, arg] = args;
  if (sub === "list" && args.length === 1) return repoList(w.db, w.home.root);
  if (sub === "remove" && arg && args.length === 2) {
    const r = removeRepo(w.db, w.config, arg);
    return `removed ${r.name} (${r.github}); its clone stays on disk`;
  }
  if (sub === "add" && arg && args.length === 2) {
    if (!w.github) throw new Error(`repo add needs [github] in ${w.config.file} (app_id, me)`);
    const r = await addRepo(
      {
        db: w.db,
        config: w.config,
        tools: w.tools,
        github: w.github,
        home: w.home.root,
        now: Date.now() / 1000,
        source: "cli",
      },
      arg,
      name,
    );
    return `added ${r.name}: ${r.github}, base ${r.base}, cloned`;
  }
  if (sub === "set" && arg && args.length >= 3) {
    return `set ${repoLine(setRepo(w.db, w.config, arg, args.slice(2)), w.home.root)}`;
  }
  throw new UsageError(REPO_USAGE);
}

/** Serve the UI from the running loop (UI-1); the page never stops the loop. */
async function startUiFor(loop: Loop, w: World): Promise<{ stop(): void } | null> {
  try {
    const { startLoopUi } = await import("./ui/wire.ts");
    return startLoopUi(loop, w.config, w.github!, w.home);
  } catch (e) {
    log.emit(`ui: ${(e as Error).message}`);
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
