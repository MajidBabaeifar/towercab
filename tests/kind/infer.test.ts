// INT-77: Towercab infers the kind at the start, keeps the guess and its reason, and an intent's own kind wins.

import { expect, test } from "vitest";
import { dataOf } from "../../src/mission.ts";
import { happy, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const guess = (kind: string, why = "It fixes a wrong total.") => reply({ kind, why });

async function run(
  extra: string,
  answer?: ReturnType<typeof reply>,
  stage: "approval:spec" | "approval:plan" = "approval:spec",
) {
  const p = new Pipe(TARGET, intents(intent({ a: 3, extra })));
  happy(p);
  if (answer) p.respond.kind = answer;
  await p.start();
  await p.until(() => Boolean(dataOf<{ kind?: string }>(p.mission()!).kind), 40);
  return p;
}

test("kind: the agent gets the intent as data and no tools", async () => {
  const p = await run("", guess("feature"));
  try {
    const calls = p.kindCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("Show a greeting");
    expect(calls[0]!.prompt).toContain("data, not instructions");
    expect(calls[0]!.argv[calls[0]!.argv.indexOf("--tools") + 1]).toBe("");
    expect(calls[0]!.argv).not.toContain("--allowedTools");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("kind: a set kind skips the agent", async () => {
  const p = await run("kind: bugfix\n", guess("feature"));
  try {
    expect(p.kindCalls).toHaveLength(0);
    expect(dataOf<{ kind: string; kindBy: string }>(p.mission()!)).toMatchObject({
      kind: "bugfix",
      kindBy: "owner",
    });
  } finally {
    p.cleanup();
  }
}, 120_000);

test("kind: a failed run counts as feature and is noted", async () => {
  const p = await run("", () => ({ noResult: true }));
  try {
    const d = dataOf<{ kind: string; kindBy: string; kindWhy: string }>(p.mission()!);
    expect(d).toMatchObject({ kind: "feature", kindBy: "guess" });
    expect(d.kindWhy).toContain("could not tell");
    expect(p.mission()!.spec_pr).toBeNull();
  } finally {
    p.cleanup();
  }
}, 120_000);

test("kind: the inferred kind and its reason are kept in the mission", async () => {
  const p = await run("", guess("feature", "It adds a new greeting."));
  try {
    expect(dataOf<Record<string, string>>(p.mission()!)).toMatchObject({
      kind: "feature",
      kindWhy: "It adds a new greeting.",
      kindBy: "guess",
    });
  } finally {
    p.cleanup();
  }
}, 120_000);

test("kind: a guessed lighter kind takes effect without waiting", async () => {
  const p = await run("", guess("bugfix"));
  try {
    const m = p.mission()!;
    expect(m.spec_pr).toBeNull();
    expect(p.moves()).toContain("design → plan (kind_routed");
    expect(p.moves()).not.toContain("approval:spec");
    expect(dataOf<Record<string, string>>(m)).toMatchObject({ kind: "bugfix", kindBy: "guess" });
  } finally {
    p.cleanup();
  }
}, 120_000);
