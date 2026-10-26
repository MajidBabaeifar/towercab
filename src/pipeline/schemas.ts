// The `--json-schema`s of the worker and review runs (pipeline.md **Schemas**): every object closed,
// every key required, `null` where optional; plus their result types and a validator for them.

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
});

export const DESIGN_SCHEMA = object({
  type: { type: "string", enum: TYPES },
  scope: S,
  breaking: BOOL,
  spec_ids: list({ type: "string", pattern: "^[A-Z]+-[0-9]+$" }),
  concerns: list(object({ what: S, why: S })),
  open_questions: list(object({ question: S, answer: S_NULL })),
  pr: S,
});

export const PLAN_SCHEMA = object({ plan: S, access: ACCESS });

export const QUESTION = object({
  context: S,
  question: S,
  // biome-ignore lint/suspicious/noThenProperty: the spec's key; this object is never awaited.
  options: list(object({ option: S, then: S })),
  recommendation: S,
});

export const BUILD_SCHEMA = object({
  status: { type: "string", enum: ["done", "blocked", "access"] },
  pr: S_NULL,
  notes: S,
  question: nullable(QUESTION),
  access: nullable(ACCESS),
  plan_changed: S_NULL,
  lower_a: { type: ["integer", "null"], minimum: 1, maximum: 5 },
  lower_why: S_NULL,
});

export const REVIEW_SCHEMA = object({
  approved: BOOL,
  outcomes: list(object({ bullet: S, met: BOOL, why: S })),
  tests_weakened: object({ value: BOOL, where: S }),
  plan_followed: object({ value: BOOL, where: S }),
  findings: list(
    object({
      severity: { type: "string", enum: ["important", "nit"] },
      file: S,
      line: { type: ["integer", "null"] },
      what: S,
    }),
  ),
  door: { type: "string", enum: ["one-way", "two-way"] },
  red_lines: list(object({ line: S, file: S })),
  summary: S,
});

export const SCHEMAS = {
  design: DESIGN_SCHEMA,
  plan: PLAN_SCHEMA,
  build: BUILD_SCHEMA,
  review: REVIEW_SCHEMA,
};

export interface Access {
  domains: { domain: string; why: string }[];
  paths: { glob: string; why: string }[];
}

export interface DesignResult {
  type: string;
  scope: string;
  breaking: boolean;
  spec_ids: string[];
  concerns: { what: string; why: string }[];
  open_questions: { question: string; answer: string | null }[];
  pr: string;
}

export interface PlanResult {
  plan: string;
  access: Access;
}

export interface Question {
  context: string;
  question: string;
  options: { option: string; then: string }[];
  recommendation: string;
}

export interface BuildResult {
  status: "done" | "blocked" | "access";
  pr: string | null;
  notes: string;
  question: Question | null;
  access: Access | null;
  plan_changed: string | null;
  lower_a: number | null;
  lower_why: string | null;
}

export interface ReviewResult {
  approved: boolean;
  outcomes: { bullet: string; met: boolean; why: string }[];
  tests_weakened: { value: boolean; where: string };
  plan_followed: { value: boolean; where: string };
  findings: { severity: "important" | "nit"; file: string; line: number | null; what: string }[];
  door: "one-way" | "two-way";
  red_lines: { line: string; file: string }[];
  summary: string;
}

export interface Results {
  design: DesignResult;
  plan: PlanResult;
  build: BuildResult;
  review: ReviewResult;
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
  const why = validate(SCHEMAS[kind], value);
  return why === null ? { ok: true, value: value as Results[K] } : { ok: false, why };
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
