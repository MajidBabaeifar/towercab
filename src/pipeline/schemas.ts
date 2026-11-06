// The `--json-schema`s of the worker and review runs (pipeline.md **Schemas**): every object closed,
// every key required, `null` where optional; plus their result types and a validator for them.

import type { PlanStep } from "../steps.ts";

/** Conventional Commit types. */
export const TYPES = [
  "feat",
  "fix",
  "perf",
  "revert",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "style",
];

export type JsonSchema = Record<string, unknown>;

const S: JsonSchema = { type: "string" };
const S_NULL: JsonSchema = { type: ["string", "null"] };
const BOOL: JsonSchema = { type: "boolean" };
const list = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });

/** An object with exactly these properties, all required. */
function object(props: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties: props, required: Object.keys(props), additionalProperties: false };
}

const ACCESS = object({
  domains: list(object({ domain: S, why: S })),
  paths: list(object({ glob: S, why: S })),
  // PIP-115, PIP-116: existing tests (files on the base branch) the plan or the worker asks to change.
  tests: list(object({ path: S, why: S })),
});

/** PIP-106: the plain brief beside the technical text, for a reader who doesn't code. */
const BRIEF: JsonSchema = S;

export const DESIGN_SCHEMA = object({
  title: S,
  subject: S,
  brief: BRIEF,
  type: { type: "string", enum: TYPES },
  scope: S,
  breaking: BOOL,
  spec_ids: list({ type: "string", pattern: "^[A-Z]+-[0-9]+$" }),
  concerns: list(object({ what: S, why: S })),
  open_questions: list(object({ question: S, answer: S_NULL })),
  pr: S,
});

/** SHIP-8: the e2e tests a change in a live repo adds, or why it needs none; null elsewhere. */
const E2E = nullable(object({ tests: list(S), none_why: S }));

/** SHIP-17: what only the owner can do for the change to work, and when it is needed. */
const OWNER_STEPS = list(
  object({
    when: { type: "string", enum: ["before", "after"] },
    text: S,
    why: S,
    // SHIP-33: a secret Towercab writes to a SOPS file; null for any other step.
    secret: nullable(
      object({
        repo: S,
        file: S,
        key: S,
        purpose: S,
        source: { type: "string", enum: ["generate", "supply"] },
        length: { type: ["integer", "null"] },
        alphabet: S_NULL,
      }),
    ),
  }),
);

/** INT-43: for a multi-repo intent, what changes in each repo and in which order the parts land; else empty. */
const REPOS = list(object({ repo: S, change: S, waits_on: list(S), safe_alone: S }));

export const PLAN_SCHEMA = object({
  brief: BRIEF,
  plan: S,
  repos: REPOS,
  access: ACCESS,
  e2e: E2E,
  owner_steps: OWNER_STEPS,
  // SHIP-21: empty, or why nothing about the change can be seen live.
  live_none_why: S,
  // PIP-112: `code` builds and ships a change; `steps` is work only the owner can do.
  delivery: { type: "string", enum: ["code", "steps"] },
});

/** PIP-114: the three things an option of a question can make Towercab do. */
export const QUESTION_DO = ["continue", "steps", "drop"];

export const QUESTION = object({
  context: S,
  question: S,
  // PIP-114: what Towercab does when the owner picks the option.
  // biome-ignore lint/suspicious/noThenProperty: the spec's key; this object is never awaited.
  options: list(object({ option: S, then: S, do: { type: "string", enum: QUESTION_DO } })),
  recommendation: S,
});

export const BUILD_SCHEMA = object({
  status: { type: "string", enum: ["done", "blocked", "access"] },
  brief: BRIEF,
  pr: S_NULL,
  notes: S,
  question: nullable(QUESTION),
  access: nullable(ACCESS),
  plan_changed: S_NULL,
  lower_a: { type: ["integer", "null"], minimum: 1, maximum: 5 },
  lower_why: S_NULL,
});

export const REVIEW_SCHEMA = object({
  brief: BRIEF,
  approved: BOOL,
  // PIP-119: `owner` is true for an outcome only the owner can do; it is not judged `met`.
  outcomes: list(object({ bullet: S, met: BOOL, owner: BOOL, why: S })),
  tests_weakened: object({ value: BOOL, where: S }),
  plan_followed: object({ value: BOOL, where: S }),
  findings: list(
    object({
      severity: { type: "string", enum: ["important", "nit"] },
      pass: S,
      file: S,
      line: { type: ["integer", "null"] },
      what: S,
    }),
  ),
  door: { type: "string", enum: ["one-way", "two-way"] },
  red_lines: list(object({ line: S, file: S })),
  summary: S,
});

/** The risk agent's assessment at a gate (PIP-96, AUT-16) and the spec's second review (PIP-97). */
export const RISK_SCHEMA = object({
  blast_radius: object({ size: { type: "string", enum: ["small", "medium", "large"] }, who: S }),
  door: object({ kind: { type: "string", enum: ["two-way", "one-way"] }, why: S }),
  certainty: object({ level: { type: "string", enum: ["high", "medium", "low"] }, why: S }),
  level: { type: "string", enum: ["low", "medium", "high"] },
  summary: S,
  open_points: list(object({ point: S, why: S })),
});

/** The scoring of a GitHub issue (INT-22). */
export const SCORE_SCHEMA = object({
  u: { type: "integer", minimum: 1, maximum: 5 },
  u_why: S,
  i: { type: "integer", minimum: 1, maximum: 5 },
  i_why: S,
  title: S,
  problem: S,
  outcome: list(S),
  affected: S,
  constraints: list(S),
  open_questions: list(S),
});

/** INT-39: a repo's live features, as short business sentences. */
export const FEATURES_SCHEMA = object({ features: list(S) });

/** SHD-5: what a shadow turn answers: the reply, reads of Towercab's state, and actions Towercab runs. */
export const SHADOW_SCHEMA = object({
  reply: S,
  reads: list(object({ kind: S, ref: S })),
  actions: list(object({ action: S, intent: S, repo: S, title: S, text: S })),
});

export const SCHEMAS = {
  design: DESIGN_SCHEMA,
  plan: PLAN_SCHEMA,
  build: BUILD_SCHEMA,
  review: REVIEW_SCHEMA,
  risk: RISK_SCHEMA,
  score: SCORE_SCHEMA,
  features: FEATURES_SCHEMA,
  shadow: SHADOW_SCHEMA,
};

export interface Access {
  domains: { domain: string; why: string }[];
  paths: { glob: string; why: string }[];
  /** PIP-115, PIP-116: existing tests to change, each a file (not a glob) with why. */
  tests: { path: string; why: string }[];
}

export interface DesignResult {
  /** INT-33, INT-34: the intent's title as a plain user story; used only for intents the owner didn't write. */
  title: string;
  /** PIP-111: the change in a few words, Conventional Commit description style, for PR titles and commits. */
  subject: string;
  /** PIP-106: what changes for users and what the owner decides, in plain words. */
  brief: string;
  type: string;
  scope: string;
  breaking: boolean;
  spec_ids: string[];
  concerns: { what: string; why: string }[];
  open_questions: { question: string; answer: string | null }[];
  pr: string;
}

export interface PlanResult {
  /** PIP-106: what the build will do and what approving it allows, in plain words. */
  brief: string;
  plan: string;
  access: Access;
  e2e: { tests: string[]; none_why: string } | null;
  /** INT-43: the parts of a multi-repo plan; absent counts as none. */
  repos?: { repo: string; change: string; waits_on: string[]; safe_alone: string }[];
  /** SHIP-17: absent counts as none. */
  owner_steps?: PlanStep[];
  /** SHIP-21: absent counts as empty. */
  live_none_why?: string;
  /** PIP-112: absent counts as `code`. */
  delivery?: "code" | "steps";
}

export interface Question {
  context: string;
  question: string;
  /** `do` is absent in questions stored before PIP-114 (and means `continue`). */
  options: { option: string; then: string; do?: "continue" | "steps" | "drop" }[];
  recommendation: string;
}

export interface BuildResult {
  status: "done" | "blocked" | "access";
  /** PIP-106: what changed for users, or what the owner is asked, in plain words. */
  brief: string;
  pr: string | null;
  notes: string;
  question: Question | null;
  access: Access | null;
  plan_changed: string | null;
  lower_a: number | null;
  lower_why: string | null;
}

export interface ReviewResult {
  /** PIP-106: the verdict and what it means for the owner's decision, in plain words. */
  brief: string;
  approved: boolean;
  /** `owner` (PIP-119): only the owner can do it; absent counts as false. */
  outcomes: { bullet: string; met: boolean; owner?: boolean; why: string }[];
  tests_weakened: { value: boolean; where: string };
  plan_followed: { value: boolean; where: string };
  findings: {
    severity: "important" | "nit";
    /** The REVIEW.md pass that found it (PIP-92). */
    pass: string;
    file: string;
    line: number | null;
    what: string;
  }[];
  door: "one-way" | "two-way";
  red_lines: { line: string; file: string }[];
  summary: string;
}

export interface RiskResult {
  /** Who or what is affected if it goes wrong. */
  blast_radius: { size: "small" | "medium" | "large"; who: string };
  /** Hard to undo (`one-way`: data, migrations, public interfaces, deletions) or easy (`two-way`). */
  door: { kind: "two-way" | "one-way"; why: string };
  /** How sure we are it behaves as expected once deployed. */
  certainty: { level: "high" | "medium" | "low"; why: string };
  level: "low" | "medium" | "high";
  summary: string;
  /** PIP-97: what the owner must decide before the spec is built; empty at the plan and code gates. */
  open_points: { point: string; why: string }[];
}

export interface ScoreResult {
  u: number;
  u_why: string;
  i: number;
  i_why: string;
  title: string;
  problem: string;
  outcome: string[];
  /** INT-32: empty when the issue doesn't say. */
  affected: string;
  constraints: string[];
  open_questions: string[];
}

export interface Results {
  design: DesignResult;
  plan: PlanResult;
  build: BuildResult;
  review: ReviewResult;
  risk: RiskResult;
  score: ScoreResult;
  features: { features: string[] };
  shadow: ShadowResult;
}

export interface ShadowResult {
  reply: string;
  reads: { kind: string; ref: string }[];
  /** `intent` for most actions; `repo`, `title` and `text` (the body) for `draft`. */
  actions: { action: string; intent: string; repo: string; title: string; text: string }[];
}

/** Why `value` doesn't fit `schema` (the subset these schemas use), or null when it does. */
export function validate(schema: JsonSchema, value: unknown, at = "result"): string | null {
  if (Array.isArray(schema.anyOf)) {
    const errs = (schema.anyOf as JsonSchema[]).map((s) => validate(s, value, at));
    return errs.includes(null) ? null : errs[0]!;
  }
  const types = schema.type === undefined ? [] : ([] as unknown[]).concat(schema.type);
  if (types.length && !types.some((t) => typeIs(String(t), value))) {
    return `${at} must be ${types.join(" or ")}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${at} must be one of ${schema.enum.map(String).join(", ")}`;
  }
  if (
    typeof value === "string" &&
    typeof schema.pattern === "string" &&
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- patterns come from Towercab's own schemas in this file, never from input
    !new RegExp(schema.pattern).test(value)
  ) {
    return `${at} must match ${schema.pattern}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return `${at} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return `${at} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const e = validate(schema.items as JsonSchema, value[i], `${at}[${i}]`);
      if (e) return e;
    }
  }
  if (isObject(value) && schema.properties) {
    const props = schema.properties as Record<string, JsonSchema>;
    for (const k of (schema.required as string[] | undefined) ?? []) {
      if (!(k in value)) return `${at}.${k} is missing`;
    }
    for (const [k, v] of Object.entries(value)) {
      const p = props[k];
      if (!p) {
        if (schema.additionalProperties === false) return `${at}.${k} is not allowed`;
        continue;
      }
      const e = validate(p, v, `${at}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

/** A run's `structured_output` as the result of `kind`, or why it isn't one. */
export function parseResult<K extends keyof Results>(
  kind: K,
  value: unknown,
): { ok: true; value: Results[K] } | { ok: false; why: string } {
  // PIP-119: a review from before `owner` existed (or a cached one) reads as `owner: false`.
  if (kind === "review" && isObject(value) && Array.isArray(value.outcomes)) {
    value = {
      ...value,
      outcomes: value.outcomes.map((o) => (isObject(o) && !("owner" in o) ? { ...o, owner: false } : o)),
    };
  }
  // SHIP-17, SHIP-21: a plan from before owner steps (or a cached one) reads as none and no claim.
  let checked = value;
  if (kind === "plan" && isObject(value)) {
    // INT-43: a plan without `repos` is a single-repo plan.
    const plan: Record<string, unknown> = {
      owner_steps: [],
      live_none_why: "",
      delivery: "code",
      repos: [],
      ...value,
    };
    value = plan;
    const own = plan.owner_steps;
    // SHIP-33: a step from before secrets reads as an ordinary one.
    checked = {
      ...plan,
      owner_steps: Array.isArray(own)
        ? own.map((s: unknown) => {
            if (!isObject(s)) return s;
            if (!("secret" in s)) return { ...s, secret: null };
            // A secret without length or alphabet leaves them unset.
            return isObject(s.secret) ? { ...s, secret: { length: null, alphabet: null, ...s.secret } } : s;
          })
        : own,
    };
  }
  const why = validate(SCHEMAS[kind], checked);
  if (why !== null) return { ok: false, why };
  if (kind === "plan" && isObject(value)) {
    const bad = secretProblem((value as Record<string, unknown>).owner_steps);
    if (bad) return { ok: false, why: bad };
  }
  // PIP-112: a plan the owner does by hand needs steps they can tick.
  if (kind === "plan" && isObject(value) && value.delivery === "steps") {
    const steps = value.owner_steps;
    if (!Array.isArray(steps) || steps.length === 0)
      return { ok: false, why: "a plan with delivery steps needs at least one owner_steps entry" };
  }
  // PIP-114: a question with no options has nothing the owner can pick.
  if (kind === "build" && isObject(value) && isObject(value.question)) {
    const options = value.question.options;
    if (Array.isArray(options) && options.length === 0)
      return { ok: false, why: "question.options needs at least one option" };
  }
  return { ok: true, value: value as Results[K] };
}

/** SHIP-33: what is wrong with the secrets of a plan's steps, or null. */
export function secretProblem(steps: unknown): string | null {
  if (!Array.isArray(steps)) return null;
  for (const st of steps) {
    const sec = isObject(st) ? st.secret : null;
    if (!isObject(sec)) continue;
    const { repo, file, key, source, length, alphabet } = sec as Record<string, unknown>;
    if (typeof repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(repo))
      return "a secret step needs the repo's short name in secret.repo";
    if (
      typeof file !== "string" ||
      !/^[A-Za-z0-9_./-]+$/.test(file) ||
      file.startsWith("/") ||
      file.split("/").includes("..")
    )
      return "a secret step needs a relative file path in secret.file";
    if (typeof key !== "string" || !/^[A-Za-z0-9_.-]+$/.test(key))
      return "a secret step needs a key of letters, digits, _, . and - in secret.key";
    if (source === "supply" && (length != null || alphabet != null))
      return "secret.length and secret.alphabet are for generate steps only";
    if (
      length != null &&
      (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 256)
    )
      return "secret.length is 1 to 256";
    if (alphabet != null && !["hex", "alnum", "urlsafe"].includes(alphabet as string))
      return "secret.alphabet is hex, alnum or urlsafe";
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeIs(t: string, v: unknown): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
    default:
      return false;
  }
}
