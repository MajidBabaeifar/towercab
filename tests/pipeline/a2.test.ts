// An a2 intent where the owner steers every step on GitHub (PIP-25, PIP-28, AUT-3, AUT-15, MET-10):
// feedback on the spec and the plan, a `/retry`, an unticked access line, a mid-build access request,
// and the owner's merges. The tests run in order, each moving the same story on.

import { afterAll, beforeAll, expect, test } from "vitest";
import {
  build,
  CODE,
  DESIGN,
  DIR,
  happy,
  ID,
  intent,
  intents,
  PLAN_MD,
  reply,
  SLUG,
  SPEC,
  TARGET,
} from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

let p: Pipe;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  happy(p);
  await p.start();
}, 30_000);

afterAll(() => p.cleanup());

const calls = (kind: string) => p.claudeCalls.filter((c) => c.kind === kind);

test("pipeline: feedback revises the spec", async () => {
  let m = await p.untilStage("approval:spec");
  expect(m.waiting).toBe("approve spec");
  const pr = p.prNo("web", m.spec_pr!);
  const before = p.headSha("owner/web", pr.head);
  p.ownerComment(pr, "Please also say what happens on an empty page.");
  p.script(reply(DESIGN, { "specs/web.md": `${SPEC["specs/web.md"]}\nAn empty page says hello too.\n` }));
  p.clock.advance(61);
  m = await p.untilStage("approval:spec");
  // The same session revised it, with the owner's words in the prompt, as a new commit on the same PR.
  const [first, second] = calls("design");
  expect(second!.session).toEqual({ mode: "resume", id: first!.session.id });
  expect(second!.prompt).toContain("Please also say what happens on an empty page.");
  expect(p.prs.filter((x) => x.repo === "owner/web")).toHaveLength(1);
  expect(m.spec_pr).toBe(pr.number);
  expect(git(p.bares.web!, "log", "--format=%s", `${before}..${pr.head}`).trim()).toBe(
    "docs(specs): Show a greeting",
  );
  expect(p.show("web", pr.head, "specs/web.md")).toContain("An empty page says hello too.");
  expect(p.stages(m.id)).toEqual(["design", "approval:spec", "design", "approval:spec"]);
}, 30_000);

test("a2 story: /retry on the spec PR starts attempt 2", async () => {
  const m1 = p.mission()!;
  p.ownerComment(p.prNo("web", m1.spec_pr!), "/retry");
  p.clock.advance(61);
  const m2 = await p.untilStage("approval:spec");
  expect(m2.attempt).toBe(2);
  expect(p.mission(m1.id)!.stage).toBe("stopped");
  expect(p.mission(m1.id)!.why).toBe("replaced by attempt 2");
  expect(m2.branch).toBe(`towercab/${ID}-${SLUG}-2`);
  expect(calls("design")[2]!.session.mode).toBe("new");
}, 30_000);

test("pipeline: feedback revises the plan", async () => {
  p.mergePr(p.prNo("web", p.mission()!.spec_pr!));
  p.script(
    reply({
      plan: PLAN_MD,
      access: { domains: [{ domain: "example.com", why: "the greeting text" }], paths: [] },
    }),
  );
  let m = await p.untilStage("approval:plan");
  expect(m.waiting).toBe("approve plan");
  const pr = p.prNo("intents", m.plan_pr!);
  expect(pr.body).toContain("network access to example.com");
  p.ownerReview(pr, "CHANGES_REQUESTED", "Also fetch the translations.");
  p.script(
    reply({
      plan: PLAN_MD.replace("Add a greeting file.", "Add a greeting file and its translations."),
      access: {
        domains: [
          { domain: "example.com", why: "the greeting text" },
          { domain: "cdn.example.com", why: "translations" },
        ],
        paths: [],
      },
    }),
  );
  p.clock.advance(61);
  m = await p.untilStage("approval:plan");
  const plans = calls("plan");
  expect(plans).toHaveLength(2);
  expect(plans[1]!.session).toEqual({ mode: "resume", id: plans[0]!.session.id });
  expect(plans[1]!.prompt).toContain("Also fetch the translations.");
  expect(m.plan_pr).toBe(pr.number);
  expect(p.prs.filter((x) => x.repo === "owner/intents")).toHaveLength(1);
  const md = p.show("intents", pr.head, `${DIR}/plan.md`);
  expect(md).toContain("Add a greeting file and its translations.");
  expect(md).toContain("- [x] network: cdn.example.com (translations)");
  expect(pr.body).toContain("network access to cdn.example.com");
}, 30_000);

test("pipeline: merged plan grants its ticked access", async () => {
  const m = p.mission()!;
  const pr = p.prNo("intents", m.plan_pr!);
  // The owner unticks one line, then merges.
  const md = p.show("intents", pr.head, `${DIR}/plan.md`);
  p.pushTo("intents", pr.head, {
    [`${DIR}/plan.md`]: md.replace("- [x] network: cdn.example.com", "- [ ] network: cdn.example.com"),
  });
  p.mergePr(pr);
  // The worker first asks for more access mid-build (AUT-15), then finishes.
  p.script(
    reply(
      build({
        status: "access",
        pr: null,
        access: { domains: [{ domain: "fonts.example.org", why: "a web font" }], paths: [] },
      }),
    ),
    reply(build(), CODE),
  );
  await p.untilStage("verify");
  const w = calls("worker")[0]!;
  const allowed = (w.settings.sandbox as { network: { allowedDomains: string[] } }).network.allowedDomains;
  expect(allowed).toContain("example.com");
  expect(allowed).not.toContain("cdn.example.com");
  expect(allowed).toContain("registry.npmjs.org");
  const perms = (w.settings.permissions as { allow: string[] }).allow;
  expect(perms).toContain("WebFetch(domain:example.com)");
  expect(perms).not.toContain("WebFetch(domain:cdn.example.com)");
  expect(JSON.parse(p.mission()!.data).granted).toEqual({
    domains: [{ domain: "example.com", why: "the greeting text" }],
    paths: [],
  });
}, 30_000);

test("autonomy: unplanned access at a1-a3 is granted", async () => {
  // Granted at once and resumed in the same build: no wait for the owner.
  const [ask, resumed] = calls("worker");
  expect(resumed!.session).toEqual({ mode: "resume", id: ask!.session.id });
  expect(resumed!.prompt).toBe("Access granted: fonts.example.org. Continue the build.");
  const allowed = (resumed!.settings.sandbox as { network: { allowedDomains: string[] } }).network
    .allowedDomains;
  expect(allowed).toContain("fonts.example.org");
  const m2 = p.mission()!;
  expect(p.stages(m2.id)).not.toContain("blocked");
  expect(JSON.parse(m2.data).unplanned).toEqual({
    domains: [{ domain: "fonts.example.org", why: "a web font" }],
    paths: [],
  });
  const m = await p.untilStage("approval:merge");
  // The owner merges at a2 anyway; the PR says what was granted beyond the plan.
  expect(m.why).toBe("autonomy a2: the owner merges");
  const body = p.prNo("web", m.pr!).body;
  expect(body).toContain("## Access beyond the plan\n\n- network access to fonts.example.org: a web font");
}, 30_000);

test("metrics: totals at done", async () => {
  const m = p.mission()!;
  p.mergePr(p.prNo("web", m.pr!));
  await p.untilStage("done");
  await p.loop.pass();
  const rows = p.db.all<{ cost_usd: number; agent_secs: number }>(
    "SELECT cost_usd, agent_secs FROM missions WHERE intent = ?",
    ID,
  );
  expect(rows).toHaveLength(2);
  const cost = rows.reduce((s, r) => s + r.cost_usd, 0);
  const secs = rows.reduce((s, r) => s + r.agent_secs, 0);
  // Attempt 1: one design session ($0.50); attempt 2: the worker session and the review ($1.00).
  expect(cost).toBeCloseTo(1.5, 6);
  expect(secs).toBe(60 * p.claudeCalls.length);
  const done = p.show("intents", "main", `done/${ID}-${SLUG}/intent.md`);
  expect(done).toContain("stage: done");
  expect(done).toContain(`cost: 1.50\nagent_time: ${secs}\nattempts: 2`);
  const view = p.show("intents", "main", "DONE.md");
  expect(view).toContain(ID);
  expect(view).toContain("$1.50");
}, 30_000);
