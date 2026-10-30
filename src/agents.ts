// Agent files (PIP-70, PIP-71): `agents/<name>.md`, front matter + the prompt as its body. They are
// the one place that says what a Claude run may do and how long and how much it may run.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "./config.ts";
import { SCHEMAS } from "./pipeline/schemas.ts";

export const AGENT_NAMES = [
  "design",
  "plan",
  "worker",
  "repair",
  "review",
  "risk",
  "score",
  "features",
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENTS_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..", "agents");

/** Claude Code tool names an agent may list. */
export const KNOWN_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch"];

export type SchemaName = keyof typeof SCHEMAS;

export interface Agent {
  name: string;
  tools: string[];
  /** `--allowedTools`: `Tool` or `Tool(pattern)`. */
  allow: string[];
  sandbox: "strict" | "none";
  /** Which configured model it takes: the mission's, the review model, or `[agent].model`. */
  model: "mission" | "review" | "agent";
  /** `resume`: the mission's session; `new`: a session of its own per run; `none`. */
  session: "new" | "resume" | "none";
  timeoutMin: number;
  maxCostUsd: number | null;
  schema: SchemaName | null;
  /** The prompt template. */
  prompt: string;
}

const KEYS = ["tools", "allow", "sandbox", "model", "session", "timeout_min", "max_cost_usd", "schema"];

const RULE = /^([A-Za-z]+)(?:\((.+)\))?$/;

/** The agent in `text` (the content of `agents/<name>.md`); an error names the file and the key. */
export function parseAgent(name: string, text: string): Agent {
  const file = `agents/${name}.md`;
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: no front matter between --- lines`);
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch (e) {
    throw new Error(`${file}: front matter is not valid YAML: ${(e as Error).message}`);
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm))
    throw new Error(`${file}: front matter is not a map`);
  const o = fm as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw new Error(`${file}: unknown key ${k}`);
  for (const k of KEYS) if (!(k in o)) throw new Error(`${file}: missing key ${k}`);

  const list = (k: string): string[] => {
    const v = o[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) {
      throw new Error(`${file}: ${k} must be a list of strings`);
    }
    return v as string[];
  };
  const oneOf = <T extends string>(k: string, values: readonly T[]): T => {
    const v = o[k];
    if (typeof v !== "string" || !values.includes(v as T)) {
      throw new Error(`${file}: ${k} must be one of ${values.join(", ")}`);
    }
    return v as T;
  };

  const tools = list("tools");
  for (const t of tools)
    if (!KNOWN_TOOLS.includes(t)) throw new Error(`${file}: tools has unknown tool ${t}`);
  const allow = list("allow");
  for (const r of allow) {
    const rm = RULE.exec(r);
    if (!rm) throw new Error(`${file}: allow rule ${r} is not Tool or Tool(pattern)`);
    if (!tools.includes(rm[1]!))
      throw new Error(`${file}: allow rule ${r} names a tool the agent doesn't have`);
  }
  const sandbox = oneOf("sandbox", ["strict", "none"] as const);
  if (sandbox === "none" && tools.length) {
    throw new Error(`${file}: sandbox may be none only for an agent with no tools`);
  }
  const timeout = o.timeout_min;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1) {
    throw new Error(`${file}: timeout_min must be a whole number of minutes, 1 or more`);
  }
  const cost = o.max_cost_usd;
  if (cost !== null && (typeof cost !== "number" || !(cost > 0))) {
    throw new Error(`${file}: max_cost_usd must be a positive number or null`);
  }
  const schema = o.schema;
  if (schema !== null && (typeof schema !== "string" || !(schema in SCHEMAS))) {
    throw new Error(`${file}: schema must be null or one of ${Object.keys(SCHEMAS).join(", ")}`);
  }
  return {
    name,
    tools,
    allow,
    sandbox,
    model: oneOf("model", ["mission", "review", "agent"] as const),
    session: oneOf("session", ["new", "resume", "none"] as const),
    timeoutMin: timeout,
    maxCostUsd: cost as number | null,
    schema: schema as SchemaName | null,
    prompt: m[2]!,
  };
}

export function loadAgent(name: string, dir = AGENTS_DIR): Agent {
  return parseAgent(name, readFileSync(join(dir, `${name}.md`), "utf8"));
}

/** The run's time limit: the file's, lowered by `[agent]` config, never raised (PIP-71). */
export function agentTimeoutMin(agent: Agent, config: Config): number {
  const cfg = agent.model === "review" ? config.agent.reviewTimeoutMin : config.agent.buildTimeoutMin;
  return Math.min(agent.timeoutMin, cfg);
}

/** The run's cost limit (`--max-budget-usd`): the file's, lowered by `[agent].max_budget_usd`. */
export function agentBudgetUsd(agent: Agent, config: Config): number | null {
  if (agent.maxCostUsd === null) return null;
  return Math.min(agent.maxCostUsd, config.agent.maxBudgetUsd);
}
