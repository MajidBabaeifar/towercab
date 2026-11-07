// Specialist reviews (PIP-197, PIP-198): a change in the security or infra area is also read by that
// specialist, next to the general review; its Important findings count, its nits don't.

import { expect, test } from "vitest";
import type { ReviewResult } from "../../src/pipeline/schemas.ts";
import { mergeSpecialists, specialistsFor } from "../../src/pipeline/specialists.ts";
import { build, CODE, happy, intent, intents, REVIEW, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const NONE = { security: [], infra: [] };

const SECURITY_FILE = { "src/auth.ts": "export const ok = true;\n" };
const AUTH_CHANGE = { ...CODE, ...SECURITY_FILE };

/** A specialist's answer: no outcomes of its own, the findings it made. */
const specialist = (o: Record<string, unknown> = {}) => ({
  ...REVIEW,
  outcomes: [],
  summary: "Specialist: nothing important.",
  ...o,
});

const BUG = {
  severity: "important",
  pass: "Bugs",
  file: "greeting.txt",
  line: 1,
  what: "The greeting has no full stop.",
};
const LEAK = {
  severity: "important",
  pass: "Security",
  file: "src/auth.ts",
  line: 1,
  what: "The token is written to the log.",
};
const NIT = {
  severity: "nit",
  pass: "Security",
  file: "src/auth.ts",
  line: 2,
  what: "Prefer a shorter name.",
};

const reviews = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "review");
const bySpecialist = (p: Pipe, which: "security" | "infra") =>
  reviews(p).filter((c) =>
    c.prompt.includes(`the ${which === "infra" ? "infrastructure" : "security"} specialist`),
  );

const fromReview = (p: Pipe, id: number) =>
  p.db
    .all<{ to_stage: string; why: string | null }>(
      "SELECT to_stage, why FROM transitions WHERE mission = ? AND from_stage = 'review' ORDER BY id",
      id,
    )
    .map((t) => [t.to_stage, t.why]);

const comments = (p: Pipe) => p.prNo("web", p.mission()!.pr!).comments.map((c) => c.body);

async function done(p: Pipe) {
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  expect(p.mission()!.stage, p.moves()).toBe("done");
}

test("pipeline: a security change gets a security review", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("worker", reply(build(), AUTH_CHANGE));
  await done(p);
  // The general review first, then the specialist, on the same inputs under its own brief.
  expect(reviews(p)).toHaveLength(2);
  expect(bySpecialist(p, "security")).toHaveLength(1);
  expect(reviews(p)[0]!.prompt).not.toContain("specialist");
  expect(reviews(p)[1]!.prompt).toContain("<intent>");
  expect(reviews(p)[1]!.prompt).toContain("git diff refs/remotes/origin/main...HEAD");
  // A session of its own, not the general review's.
  expect(reviews(p)[1]!.session.mode).toBe("new");
  expect(reviews(p)[1]!.session.id).not.toBe(reviews(p)[0]!.session.id);
  // One Review comment, not one per reviewer.
  expect(comments(p).filter((b) => b.startsWith("<!-- towercab:review:"))).toHaveLength(1);
}, 30_000);

test("pipeline: an infra change gets an infra review", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("worker", reply(build(), { ...CODE, "deploy/run.sh": "echo deploy\n" }));
  await done(p);
  expect(bySpecialist(p, "infra")).toHaveLength(1);
  expect(bySpecialist(p, "security")).toHaveLength(0);
  expect(reviews(p)).toHaveLength(2);
}, 30_000);

test("pipeline: a change outside the specialist areas gets only the general review", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  await done(p);
  expect(reviews(p)).toHaveLength(1);
  expect(reviews(p)[0]!.prompt).not.toContain("specialist");
}, 30_000);

test("pipeline: a repo's specialist paths also call in a specialist", async () => {
  const target = { ...TARGET, "REVIEW.md": "## Specialist paths\n\n- security: lib/keys.ts\n" };
  const p = new Pipe(target, intents(intent({ a: 5 })));
  happy(p);
  p.queue("worker", reply(build(), { ...CODE, "lib/keys.ts": "export {};\n" }));
  await done(p);
  expect(bySpecialist(p, "security")).toHaveLength(1);
  // The default list still counts next to the repo's own.
  expect(specialistsFor(["deploy/x.sh"], { security: ["lib/keys.ts"], infra: [] })).toEqual(["infra"]);
  expect(specialistsFor(["lib/keys.ts"], NONE)).toEqual([]);
  expect(specialistsFor(["lib/keys.ts", "src/session.ts"], { security: ["lib/keys.ts"], infra: [] })).toEqual(
    ["security"],
  );
});

test("pipeline: specialist areas are matched by path", () => {
  const areas = (f: string) => specialistsFor([f], NONE);
  expect(areas("src/auth/login.ts")).toEqual(["security"]);
  expect(areas("src/authToken.ts")).toEqual(["security"]);
  expect(areas("config/secrets.yml")).toEqual(["security"]);
  expect(areas("README.md")).toEqual([]);
  expect(areas("docs/authors.md")).toEqual([]);
  expect(areas("Dockerfile")).toEqual(["infra"]);
  expect(areas("services/api/Dockerfile.prod")).toEqual(["infra"]);
  expect(areas("systemd/app.service")).toEqual(["infra"]);
  expect(areas("ansible/site.yml")).toEqual(["infra"]);
  expect(areas(".github/workflows/ci.yml")).toEqual(["infra"]);
  expect(specialistsFor(["deploy/auth.sh"], NONE)).toEqual(["security", "infra"]);
  // Nothing of Towercab itself is in the shared default.
  expect(areas("src/pipeline/guard.ts")).toEqual([]);
  // A bad glob in a repo's list is skipped.
  expect(specialistsFor(["a.txt"], { security: ["["], infra: ["a.txt"] })).toEqual(["infra"]);
});

test("pipeline: specialist review reused for an unchanged diff", async () => {
  const README = `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  const p = new Pipe({ ...TARGET, "README.md": README }, intents(intent({ a: 5 })));
  happy(p);
  p.queue(
    "worker",
    reply(build(), { ...AUTH_CHANGE, "README.md": README.replace("line 10", "line 10, with a greeting") }),
  );
  await p.start();
  const gates = () =>
    p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE to_stage = 'gate'")!.n;
  await p.until(() => gates() === 1);
  // Main moves on (the diff's line numbers shift, what it changes doesn't); GitHub says BEHIND.
  p.pushTo("web", "main", { "README.md": `# Web\n\n${README}` });
  p.prNo("web", p.mission()!.pr!).mergeStates.push("BEHIND");
  await p.until(() => p.mission()?.stage === "done");
  expect(p.mission()!.stage, p.moves()).toBe("done");
  const moves = p.db
    .all<{ why: string | null }>("SELECT why FROM transitions WHERE from_stage = 'review' ORDER BY id")
    .map((t) => t.why);
  expect(moves).toEqual([null, "the diff is unchanged: the review stands"]);
  // The general review and its specialist ran once; the second pass reran neither.
  expect(reviews(p)).toHaveLength(2);
  expect(bySpecialist(p, "security")).toHaveLength(1);
}, 60_000);

test("pipeline: specialist nits are dropped", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("worker", reply(build(), AUTH_CHANGE));
  p.queue("review", reply(REVIEW), reply(specialist({ findings: [NIT] })));
  await done(p);
  expect(comments(p).join("\n")).not.toContain("Prefer a shorter name.");
  // The same in the join itself, whatever the repo's cap for nits.
  const general = REVIEW as unknown as ReviewResult;
  const merged = mergeSpecialists(general, [
    { area: "security", result: specialist({ findings: [NIT, LEAK] }) as unknown as ReviewResult },
  ]);
  expect(merged.findings).toEqual([LEAK]);
});

test("pipeline: a specialist's important finding stops approval", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("worker", reply(build(), AUTH_CHANGE), reply(build(), { "src/auth.ts": "export const ok = 1;\n" }));
  p.queue("review", reply(REVIEW), reply(specialist({ approved: false, findings: [LEAK] })));
  await done(p);
  // The general review approved, the specialist didn't: the change went back to the builder.
  expect(fromReview(p, p.mission()!.id)[0]).toEqual(["build", "the review didn't approve: fix round 1 of 2"]);
  const general = REVIEW as unknown as ReviewResult;
  const merged = mergeSpecialists(general, [
    {
      area: "security",
      result: specialist({ approved: false, findings: [LEAK], door: "one-way" }) as unknown as ReviewResult,
    },
  ]);
  expect([merged.approved, merged.door]).toEqual([false, "one-way"]);
}, 30_000);

test("pipeline: specialist findings go back to the builder in the same fix rounds", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  const no = reply(specialist({ approved: false, findings: [LEAK] }));
  p.queue(
    "worker",
    reply(build(), AUTH_CHANGE),
    reply(build(), { "src/auth.ts": "export const ok = 1;\n" }),
    reply(build(), { "src/auth.ts": "export const ok = 2;\n" }),
  );
  p.queue("review", reply(REVIEW), no, reply(REVIEW), no, reply(REVIEW), no);
  await p.start();
  const m = await p.untilStage("approval:merge");
  // Two fix rounds as for the general review, no extra ones for the specialist.
  expect(fromReview(p, m.id)).toEqual([
    ["build", "the review didn't approve: fix round 1 of 2"],
    ["build", "the review didn't approve: fix round 2 of 2"],
    ["gate", null],
  ]);
  expect(m.why).toBe("The independent code review didn't approve it, even after fix rounds.");
  expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(3);
}, 30_000);

test("pipeline: both reviewers' findings go into one fix round", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("worker", reply(build(), AUTH_CHANGE), reply(build(), { "src/auth.ts": "export const ok = 1;\n" }));
  p.queue(
    "review",
    reply({ ...REVIEW, approved: false, findings: [BUG], summary: "Not yet: one bug." }),
    reply(specialist({ approved: false, findings: [LEAK] })),
  );
  await done(p);
  const workers = p.claudeCalls.filter((c) => c.kind === "worker");
  // One repair run with both reviewers' findings, then a new review of the new diff.
  expect(workers).toHaveLength(2);
  expect(workers[1]!.prompt).toContain("The greeting has no full stop.");
  expect(workers[1]!.prompt).toContain("The token is written to the log.");
  expect(JSON.parse(p.mission()!.data).reviewFixes).toBe(1);
}, 30_000);

test("pipeline: review comment shows specialist findings under their pass", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("worker", reply(build(), AUTH_CHANGE), reply(build(), { "src/auth.ts": "export const ok = 1;\n" }));
  p.queue(
    "review",
    reply(REVIEW),
    reply(specialist({ approved: false, findings: [LEAK], summary: "Security: a token is logged." })),
  );
  await done(p);
  const first = comments(p).find((b) => b.startsWith("<!-- towercab:review:"))!;
  expect(first).toContain(
    "**Needs attention**\n\n- Security · `src/auth.ts:1`: The token is written to the log.",
  );
  expect(first).toContain("**Security review**\n\nSecurity: a token is logged.");
}, 30_000);
