// The `live` block of `TOWERCAB.md` (SHIP-1): where the app runs, how Towercab learns what is live,
// and the e2e suites it runs against it.

import { glob } from "../repo/protected.ts";

export interface Suite {
  name: string;
  command: string;
  /** Globs where the suite's e2e tests live. */
  tests: string[];
  /** Source globs that make the suite relevant to a change. */
  paths: string[];
  /** Run after a rollback (SHIP-10). */
  smoke: boolean;
}

export interface Live {
  url: string;
  environment: string;
  adapter: "github" | "command";
  liveCommand: string | null;
  rollbackCommand: string | null;
  /** Minutes to wait for a deploy. */
  timeout: number;
  suites: Suite[];
}

export const DEFAULT_TIMEOUT_MIN = 20;

/**
 * The live app's host, the one domain the ship stage's commands may reach beyond the registry list and the
 * plan's grants (SHIP-5, SHIP-9): it is the app the change was just shipped to. A platform's API is a plan
 * grant, not a repo-file setting. [] when the URL has no usable host.
 */
export function liveDomains(live: Pick<Live, "url">): string[] {
  try {
    const host = new URL(live.url).hostname;
    return host ? [host] : [];
  } catch {
    return [];
  }
}

const LIVE_KEYS = ["url", "environment", "adapter", "live_command", "rollback_command", "timeout", "suites"];
const SUITE_KEYS = ["name", "command", "tests", "paths", "smoke"];

/** The parsed YAML value of `live:` → a `Live`; throws `live: <why>`. */
export function parseLive(v: unknown): Live {
  try {
    return liveOf(v);
  } catch (e) {
    throw new Error(`live: ${(e as Error).message}`);
  }
}

function liveOf(v: unknown): Live {
  const m = mapping(v, "must be a mapping");
  for (const k of m.keys()) if (!LIVE_KEYS.includes(k)) throw new Error(`unknown key ${k}`);
  const url = text(m.get("url"), "url");
  if (!/^https:\/\/[^\s/]+/.test(url)) throw new Error("url must be an https:// URL");
  const environment = m.has("environment") ? text(m.get("environment"), "environment") : "production";
  const adapter = m.has("adapter") ? text(m.get("adapter"), "adapter") : "github";
  if (adapter !== "github" && adapter !== "command") throw new Error("adapter must be github or command");
  const liveCommand = m.has("live_command") ? text(m.get("live_command"), "live_command") : null;
  const rollbackCommand = m.has("rollback_command")
    ? text(m.get("rollback_command"), "rollback_command")
    : null;
  if (adapter === "command" && (!liveCommand || !rollbackCommand))
    throw new Error("the command adapter needs live_command and rollback_command");
  let timeout = DEFAULT_TIMEOUT_MIN;
  if (m.has("timeout")) {
    const t = m.get("timeout");
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 120)
      throw new Error("timeout must be whole minutes, 1-120");
    timeout = t;
  }
  const raw = m.get("suites");
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("suites must list at least one suite");
  const suites = raw.map((s, i) => suiteOf(s, i + 1));
  const names = new Set<string>();
  for (const s of suites) {
    if (names.has(s.name)) throw new Error(`suite ${s.name} twice`);
    names.add(s.name);
  }
  return {
    url: url.replace(/\/+$/, ""),
    environment,
    adapter,
    liveCommand,
    rollbackCommand,
    timeout,
    suites,
  };
}

function suiteOf(v: unknown, n: number): Suite {
  const m = mapping(v, `suite ${n} must be a mapping`);
  for (const k of m.keys()) if (!SUITE_KEYS.includes(k)) throw new Error(`suite ${n}: unknown key ${k}`);
  const name = text(m.get("name"), `suite ${n}: name`);
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`suite ${n}: name must be lowercase letters, digits and -`);
  const command = text(m.get("command"), `suite ${name}: command`);
  if (command.includes("\n")) throw new Error(`suite ${name}: command must be one line`);
  const tests = globs(m.get("tests"), `suite ${name}: tests`);
  if (tests.length === 0) throw new Error(`suite ${name}: tests must list at least one glob`);
  const paths = m.has("paths") ? globs(m.get("paths"), `suite ${name}: paths`) : [];
  const smoke = m.get("smoke") ?? false;
  if (typeof smoke !== "boolean") throw new Error(`suite ${name}: smoke must be true or false`);
  return { name, command, tests, paths, smoke };
}

function mapping(v: unknown, why: string): Map<string, unknown> {
  if (!(v instanceof Map)) throw new Error(why);
  for (const k of v.keys()) if (typeof k !== "string") throw new Error(why);
  return v as Map<string, unknown>;
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${what} is required`);
  return v.trim();
}

function globs(v: unknown, what: string): string[] {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string"))
    throw new Error(`${what} must be a list of globs`);
  for (const g of list) {
    try {
      glob(g);
    } catch (e) {
      throw new Error(`${what}: ${(e as Error).message}`);
    }
  }
  return list as string[];
}

/** The suites to run after a rollback: the smoke ones, or all when none is marked (SHIP-10). */
export function smokeSuites(live: Live): Suite[] {
  const s = live.suites.filter((x) => x.smoke);
  return s.length ? s : live.suites;
}

/**
 * SHIP-9's order: suites whose tests match a changed file, then those whose paths do, then the
 * rest, each group in file order.
 */
export function suiteOrder(live: Live, changed: string[]): Suite[] {
  const hits = (gs: string[]) => {
    const ms = gs.map((g) => glob(g));
    return changed.some((p) => ms.some((match) => match(p)));
  };
  const first = live.suites.filter((s) => hits(s.tests));
  const second = live.suites.filter((s) => !first.includes(s) && hits(s.paths));
  return [...first, ...second, ...live.suites.filter((s) => !first.includes(s) && !second.includes(s))];
}

/** What the plan and review agents are told about the repo's e2e suites (SHIP-8). */
export function e2eText(live: Live | null, agent: "plan" | "review"): string {
  if (!live) return agent === "plan" ? "This repo has no e2e suites: return `e2e` as null." : "";
  const suites = live.suites.map(
    (s) => `- \`${s.name}\`: tests in ${s.tests.map((g) => `\`${g}\``).join(", ")}`,
  );
  const head = `After each merge, Towercab runs this repo's e2e suites against the live app at ${live.url}:\n${suites.join("\n")}`;
  if (agent === "plan")
    return `${head}\n\nPlan the e2e tests the change adds under those globs and list them in \`e2e.tests\`. When the change has nothing a user of the app could see, leave \`tests\` empty and say why in \`e2e.none_why\`.`;
  return `${head}\n\nCheck that the change adds e2e tests under those globs that cover its new behaviour, unless the plan says why none is needed. A missing or weak e2e test is an important finding.`;
}

/** Test files minus e2e tests: those need the live app, so the proof and fast checks skip them (SHIP-8). */
export function withoutE2e(paths: string[], live: Live | null): string[] {
  if (!live) return paths;
  const ms = live.suites.flatMap((s) => s.tests).map((g) => glob(g));
  return paths.filter((p) => !ms.some((match) => match(p)));
}
