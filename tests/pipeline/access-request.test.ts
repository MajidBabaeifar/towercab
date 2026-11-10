// Mid-build access is asked, never granted by Towercab (AUT-15, AUT-26, AUT-27, PIP-164): a worker's request
// for a domain or protected path is a question to the owner at every level; an invalid domain is refused
// without asking; a plan's invalid grant waits for the owner; the owner's answer decides.

import { expect, test } from "vitest";
import { accessPolicy } from "../../src/autonomy.ts";
import type { Mission } from "../../src/mission.ts";
import { accessQuestion, answerAccess, grantsFor, mergeNet, type NetAsk } from "../../src/pipeline/access.ts";
import { DEFAULT_NETWORK } from "../../src/pipeline/sandbox.ts";
import { build, CODE, happy, intent, intents, PLAN, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

/** The owner merges whatever spec or plan PR a mission waits on. */
function ownerMerges(p: Pipe): void {
  for (const m of p.db.all<Mission>("SELECT * FROM missions WHERE stage LIKE 'approval:%' AND step = ''")) {
    if (m.stage === "approval:merge") continue;
    const [repo, n] = m.stage === "approval:spec" ? ["web", m.spec_pr] : ["intents", m.plan_pr];
    const pr = p.prNo(repo!, n!);
    if (pr.state === "OPEN") p.mergePr(pr);
  }
}

/** Runs passes, with the owner merging the spec and plan, until `stage`. */
async function until(p: Pipe, stage: string): Promise<Mission> {
  await p.until(() => {
    ownerMerges(p);
    return p.mission()?.stage === stage;
  });
  return p.mission()!;
}

const ask = (domain: string, why = "a web font") =>
  reply(build({ status: "access", pr: null, access: { domains: [{ domain, why }], paths: [], tests: [] } }));

test("autonomy: unplanned access asks the owner at every level", async () => {
  for (const a of [1, 2, 3, 4, 5]) {
    const p = new Pipe(TARGET, intents(intent({ a })));
    try {
      happy(p);
      p.queue("worker", ask("fonts.example.org"));
      await p.start();
      const m = await until(p, "blocked");
      expect([a, m.waiting, m.why]).toEqual([
        a,
        "answer the question",
        "May the worker have fonts.example.org?",
      ]);
      const d = JSON.parse(m.data) as { unplanned?: unknown; accessAsk?: NetAsk };
      // Nothing was granted, the worker was not resumed, and the question is recorded.
      expect(d.unplanned).toBeUndefined();
      expect(d.accessAsk).toEqual({
        domains: [{ domain: "fonts.example.org", why: "a web font" }],
        paths: [],
      });
      expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(1);
      const q = accessQuestion(d.accessAsk!);
      expect(q.options.map((o) => o.option)).toEqual(["Allow this access", "No, finish without it"]);
    } finally {
      p.cleanup();
    }
  }
}, 60_000);

test("autonomy: an invalid mid-build request is refused", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 3 })));
  try {
    happy(p);
    p.queue("worker", ask("*", "everything"), reply(build(), CODE));
    await p.start();
    await until(p, "verify");
    // Refused without asking: the worker carried on at once, was told why, and got nothing.
    const [first, resumed] = p.claudeCalls.filter((c) => c.kind === "worker");
    expect(resumed!.session).toEqual({ mode: "resume", id: first!.session.id });
    expect(resumed!.prompt).toContain("Refused without asking");
    expect(resumed!.prompt).toContain("* (it would open the whole internet)");
    const m = p.mission()!;
    expect(p.stages(m.id)).not.toContain("blocked");
    expect(JSON.parse(m.data).unplanned).toBeUndefined();
    const allowed = (resumed!.settings.sandbox as { network: { allowedDomains: string[] } }).network
      .allowedDomains;
    expect(allowed).toEqual([...DEFAULT_NETWORK]);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("autonomy: an invalid grant in a plan waits for the owner", async () => {
  // At a5 a plan would merge itself; a grant that is not a domain stops it for the owner.
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  try {
    happy(p);
    p.queue(
      "plan",
      reply({ ...PLAN, access: { domains: [{ domain: "*", why: "anything" }], paths: [], tests: [] } }),
    );
    await p.start();
    const m = await p.untilStage("approval:plan");
    expect(m.waiting).toBe("approve plan");
    expect(m.why).toBe(
      "The plan asks for network access that is not a domain, so the worker won't get it: * (it would open the whole internet).",
    );
  } finally {
    p.cleanup();
  }
}, 60_000);

test("autonomy: a5 has no open network", () => {
  for (const a of [0, 1, 2, 3, 4, 5]) expect(accessPolicy(a).network, `a${a}`).toBe("list");
  const g = grantsFor({
    a: 5,
    source: "me",
    plan: { domains: [{ domain: "api.example.com", why: "docs" }], paths: [], tests: [] },
    unlock: [],
    network: [],
    defaults: [...DEFAULT_NETWORK],
    unplanned: null,
  });
  expect(g.open).toBeUndefined();
  expect(g.domains).toEqual([...DEFAULT_NETWORK, "api.example.com"]);
});

test("autonomy: the default network list is fixed in code", async () => {
  const { parseConfig } = await import("../../src/config.ts");
  const c = parseConfig(
    { agent: { network: ["only.example.com"] }, intents: { remote: "r" } },
    "/x/config.toml",
  );
  // The key loads and doctor names it; no grant or run reads it.
  expect(c.agent.ignored).toContain("network");
  const g = grantsFor({
    a: 3,
    source: "me",
    plan: null,
    unlock: [],
    network: [],
    defaults: [...DEFAULT_NETWORK],
    unplanned: null,
  });
  expect(g.domains).toEqual([...DEFAULT_NETWORK]);
  expect(Object.isFrozen(DEFAULT_NETWORK) || Array.isArray(DEFAULT_NETWORK)).toBe(true);
});

test("autonomy: allowing unplanned access grants it", () => {
  const asked: NetAsk = {
    domains: [{ domain: "fonts.example.org", why: "a web font" }],
    paths: [{ glob: ".github/workflows/ci.yml", why: "the job" }],
  };
  const r = answerAccess(asked, {}, "yes, go ahead");
  expect(r.patch.unplanned).toEqual(asked);
  expect(r.patch.refusedAccess).toBeUndefined();
  expect(r.note).toContain("fonts.example.org, .github/workflows/ci.yml");
  // The owner's grant now reaches the worker (by `unplanned`), at a4 with the protected path too.
  const g = grantsFor({
    a: 4,
    source: "me",
    plan: null,
    unlock: [],
    network: [],
    defaults: [...DEFAULT_NETWORK],
    unplanned: r.patch.unplanned!,
  });
  expect(g.domains).toContain("fonts.example.org");
  expect(g.paths).toEqual([".github/workflows/ci.yml"]);
});

test("autonomy: a refused access stays refused", () => {
  const asked: NetAsk = { domains: [{ domain: "fonts.example.org", why: "a web font" }], paths: [] };
  const r = answerAccess(asked, {}, "No, finish without it");
  expect(r.patch.unplanned).toBeUndefined();
  expect(r.patch.refusedAccess).toEqual(asked);
  expect(r.note).toContain("Finish without it");
  // Later answers add to it; asking again is recognised from `refusedAccess`.
  const more = answerAccess(
    { domains: [{ domain: "b.example.org", why: "x" }], paths: [] },
    { refusedAccess: asked },
    "no",
  );
  expect(more.patch.refusedAccess!.domains.map((d) => d.domain)).toEqual([
    "fonts.example.org",
    "b.example.org",
  ]);
  // A reply that is neither decides nothing (PIP-139).
  const unclear = answerAccess(asked, {}, "hmm, what is it for?");
  expect(unclear.read.undecided).toEqual(["fonts.example.org"]);
  expect(unclear.patch).toEqual({});
  expect(mergeNet(asked, asked)).toEqual(asked);
});
