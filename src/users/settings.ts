// USR-14: settings an admin may change from the page. The config file stays the truth: only the changed
// keys are written, every other line byte-identical (`setConfigKey`). Anything not listed here is a
// security setting (the sandbox and its access, autonomy defaults, tokens, sign-in, budgets above their
// cap) and is changed only by editing the file.

import { type ConfigValue, parseAmount, reloadBudgets, setConfigKey } from "../budgets.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { record } from "./store.ts";

export const SECURITY_REFUSAL = "this is a security setting: edit the config file";

type Kind =
  | { kind: "int"; min: number; max: number }
  | { kind: "word" }
  | { kind: "bool" }
  | { kind: "budget" };

interface Setting {
  path: string;
  key: string;
  type: Kind;
  read(c: Config): ConfigValue | null;
}

const int = (min: number, max: number): Kind => ({ kind: "int", min, max });

/** The settings the page may change, as `[table] key`. */
const EDITABLE: Setting[] = [
  { path: "agent", key: "model", type: { kind: "word" }, read: (c) => c.agent.model },
  { path: "agent", key: "review_model", type: { kind: "word" }, read: (c) => c.agent.reviewModel },
  { path: "agent", key: "parallel", type: int(1, 16), read: (c) => c.agent.parallel },
  { path: "agent", key: "build_timeout", type: int(1, 1440), read: (c) => c.agent.buildTimeoutMin },
  { path: "agent", key: "review_timeout", type: int(1, 1440), read: (c) => c.agent.reviewTimeoutMin },
  { path: "agent", key: "check_timeout", type: int(1, 1440), read: (c) => c.agent.checkTimeoutMin },
  { path: "agent", key: "max_build_runs", type: int(1, 50), read: (c) => c.agent.maxBuildRuns },
  { path: "agent", key: "ci_poll", type: int(5, 3600), read: (c) => c.agent.ciPoll },
  { path: "agent", key: "ci_grace", type: int(0, 3600), read: (c) => c.agent.ciGrace },
  { path: "agent", key: "ci_wait", type: int(60, 86400), read: (c) => c.agent.ciWait },
  { path: "agent", key: "freeze_wait", type: int(1, 1440), read: (c) => c.agent.freezeWaitMin },
  { path: "intents", key: "cutoff", type: int(1, 15), read: (c) => c.intents.cutoff },
  { path: "update", key: "auto", type: { kind: "bool" }, read: (c) => c.update.auto },
  { path: "update", key: "drain_minutes", type: int(1, 1440), read: (c) => c.update.drainMinutes },
  // A budget may be changed up to the monthly budget the file sets (its cap).
  { path: "agent", key: "daily_budget_usd", type: { kind: "budget" }, read: (c) => c.agent.dailyBudgetUsd },
];

/** What the page lists as read-only: the security settings that hold no secret. */
function securityOf(c: Config): { key: string; value: string }[] {
  return [
    { key: "agent.monthly_budget_usd", value: String(c.budgets.monthlyUsd ?? "none") },
    { key: "agent.max_budget_usd", value: String(c.agent.maxBudgetUsd) },
    { key: "agent.network", value: c.agent.network.join(", ") },
    { key: "agent.sandbox_unix_sockets", value: String(c.agent.sandboxUnixSockets) },
    { key: "intents.issue_a", value: String(c.intents.issueA) },
    { key: "intents.owner_waits", value: String(c.intents.ownerWaits) },
  ];
}

export interface SettingsView {
  editable: { key: string; value: ConfigValue | null; kind: Kind["kind"]; min?: number; max?: number }[];
  security: { key: string; value: string }[];
  note: string;
}

/** USR-14: what an admin sees. No token, secret or chat id is in it (USR-13). */
export function settingsView(c: Config): SettingsView {
  return {
    editable: EDITABLE.map((s) => ({
      key: `${s.path}.${s.key}`,
      value: s.read(c),
      kind: s.type.kind,
      ...(s.type.kind === "int" ? { min: s.type.min, max: s.type.max } : {}),
    })),
    security: securityOf(c),
    note: "Security settings: edit the config file.",
  };
}

function checked(s: Setting, v: unknown): ConfigValue | null {
  const label = `${s.path}.${s.key}`;
  switch (s.type.kind) {
    case "int":
      if (typeof v !== "number" || !Number.isInteger(v) || v < s.type.min || v > s.type.max) {
        throw new Error(`${label} must be a whole number from ${s.type.min} to ${s.type.max}`);
      }
      return v;
    case "word":
      if (v === null && s.key === "review_model") return null;
      if (typeof v !== "string" || !v || /\s/.test(v)) throw new Error(`${label} must be a single word`);
      return v;
    case "bool":
      if (typeof v !== "boolean") throw new Error(`${label} must be true or false`);
      return v;
    case "budget":
      return parseAmount(v);
  }
}

/**
 * Write the changed settings (`{ "agent.parallel": 3 }`) to the config file and log each as
 * `user_events`. Refuses a security key, and a budget above the monthly budget the file sets. Resolves
 * with the sentence the page shows.
 */
export function changeSettings(
  d: { db: Db; config: Config; now: number; by: string },
  changes: Record<string, unknown>,
): string {
  const entries = Object.entries(changes);
  if (entries.length === 0) throw new Error("nothing to change");
  const plan: { s: Setting; value: ConfigValue | null; old: ConfigValue | null }[] = [];
  for (const [name, raw] of entries) {
    const s = EDITABLE.find((e) => `${e.path}.${e.key}` === name);
    if (!s) throw new Error(`${name}: ${SECURITY_REFUSAL}`);
    const value = checked(s, raw);
    const cap = d.config.budgets.monthlyUsd;
    if (s.type.kind === "budget" && cap !== null && (typeof value !== "number" || value > cap)) {
      throw new Error(`${name}: above its cap of $${cap} (agent.monthly_budget_usd): edit the config file`);
    }
    plan.push({ s, value, old: s.read(d.config) });
  }
  let budget = false;
  let n = 0;
  for (const { s, value, old } of plan) {
    if (value === old) continue;
    setConfigKey(d.config.file, s.path, s.key, value);
    record(d.db, d.now, d.by, "setting", `${s.path}.${s.key}`, `${old ?? "none"} → ${value ?? "none"}`);
    budget ||= s.type.kind === "budget";
    n++;
  }
  if (budget) reloadBudgets(d.config);
  if (n === 0) return "Nothing changed.";
  return budget
    ? "Saved. The budget applies now; the other settings apply after the next restart."
    : "Saved to the config file. Applies after the next restart.";
}
