// The run schemas (pipeline.md **Schemas**): closed objects, every key required, results validated.

import { expect, test } from "vitest";
import { type JsonSchema, parseResult, SCHEMAS, validate } from "../../src/pipeline/schemas.ts";

/** Every object schema inside `s`. */
function objects(s: unknown, out: JsonSchema[] = []): JsonSchema[] {
  if (Array.isArray(s)) for (const x of s) objects(x, out);
  else if (typeof s === "object" && s !== null) {
    const o = s as JsonSchema;
    if (o.type === "object") out.push(o);
    for (const v of Object.values(o)) objects(v, out);
  }
  return out;
}

const BUILD = {
  status: "blocked",
  pr: null,
  notes: "stuck",
  question: {
    context: "c",
    question: "q?",
    // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
    options: [{ option: "a", then: "b" }],
    recommendation: "a",
  },
  access: null,
  plan_changed: null,
  lower_a: 2,
  lower_why: "risky",
};

test("schemas: closed objects, every key required", () => {
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    const objs = objects(schema);
    expect(objs.length, kind).toBeGreaterThan(0);
    for (const o of objs) {
      expect(o.additionalProperties, kind).toBe(false);
      expect(o.required, kind).toEqual(Object.keys(o.properties as object));
    }
  }
  expect(parseResult("build", BUILD)).toEqual({ ok: true, value: BUILD });
  expect(parseResult("build", { ...BUILD, extra: 1 })).toEqual({
    ok: false,
    why: "result.extra is not allowed",
  });
  const { notes: _, ...noNotes } = BUILD;
  expect(parseResult("build", noNotes)).toEqual({ ok: false, why: "result.notes is missing" });
  expect(parseResult("build", { ...BUILD, lower_a: 7 })).toEqual({
    ok: false,
    why: "result.lower_a must be at most 5",
  });
  expect(parseResult("build", { ...BUILD, status: "maybe" }).ok).toBe(false);
  expect(
    validate(SCHEMAS.design, {
      type: "feat",
      scope: "",
      breaking: false,
      spec_ids: ["pip-4"],
      concerns: [],
      open_questions: [],
      pr: "",
    }),
  ).toBe("result.spec_ids[0] must match ^[A-Z]+-[0-9]+$");
  expect(
    parseResult("review", {
      approved: true,
      outcomes: [{ bullet: "b", met: true, why: "w" }],
      tests_weakened: { value: false, where: "" },
      plan_followed: { value: true, where: "" },
      findings: [{ severity: "nit", pass: "Bugs", file: "a.ts", line: null, what: "x" }],
      door: "two-way",
      red_lines: [],
      summary: "ok",
    }).ok,
  ).toBe(true);
  expect(parseResult("plan", { plan: "p", access: { domains: [], paths: [{ glob: "x" }] } })).toEqual({
    ok: false,
    why: "result.access.paths[0].why is missing",
  });
});
