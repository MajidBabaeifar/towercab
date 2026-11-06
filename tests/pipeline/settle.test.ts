// A spec settles after two rounds of owner answers (PIP-165, PIP-166): the design and the second
// reviewer raise no new open points, apart from a labelled unsafe gap, through the real pipeline.

import { expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import type { PipeData } from "../../src/pipeline/common.ts";
import { DESIGN, happy, intent, intents, reply, risk, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const data = (m: Mission) => JSON.parse(m.data) as PipeData;

const point = (text: string) => ({ point: text, why: "The copy depends on it." });
const ASKED = "Greet in the visitor's language?";
const DECISIONS = "## Decisions\n\n- Language: English only, it is the easiest to undo.";

/** A pipeline whose second reviewer answers `points[i]` at the i-th spec check. */
function start(...points: { point: string; why: string }[][]): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  p.queue("risk", ...points.map((open_points) => reply(risk({ open_points }))));
  return p;
}

const designs = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "design");
const specOf = (n: number) => ({ "specs/web.md": `${SPEC["specs/web.md"]}\nRevision ${n}.\n` });

/** The owner answers the spec PR; `next` is the design run that follows. Waits for its end. */
async function answer(p: Pipe, text: string, next: ReturnType<typeof reply>): Promise<Mission> {
  const runs = designs(p).length;
  p.script(next);
  p.ownerComment(p.prNo("web", p.mission()!.spec_pr!), text);
  p.clock.advance(61);
  await p.until(() => {
    const m = p.mission();
    return designs(p).length === runs + 1 && (m?.stage === "approval:spec" || m?.stage === "done");
  });
  return p.mission()!;
}

/** Two answered rounds, then the third design run returning `third`; the second reviewer sees `last`. */
async function settled(third: ReturnType<typeof reply>, ...last: { point: string; why: string }[][]) {
  const p = start([point(ASKED)], [point("Which font?")], ...last);
  await p.start();
  await p.untilStage("approval:spec");
  await answer(p, "English only.", reply({ ...DESIGN, open_questions: [{ question: ASKED, answer: null }] }));
  const m = await answer(p, "System font.", third);
  return { p, m };
}

test("pipeline: a third design run after two answered rounds leaves no open points and lists its decisions", async () => {
  const { p, m } = await settled(
    reply(
      {
        ...DESIGN,
        open_questions: [{ question: "Which font?", answer: null }],
        pr: `Greets.\n\n${DECISIONS}`,
      },
      specOf(3),
    ),
    [],
  );
  expect(m.stage, p.moves()).toBe("done");
  expect(designs(p)).toHaveLength(3);
  expect(designs(p)[2]!.prompt).toContain("it is settled");
  expect(designs(p)[2]!.prompt).toContain("## Decisions");
  const d = data(m);
  expect(d.design?.open).toEqual([]);
  expect(d.risk?.spec?.openPoints).toEqual([]);
  const body = p.prNo("web", m.spec_pr!).body;
  expect(body).toContain(DECISIONS);
  expect(body).not.toContain("Open points for you");
}, 60_000);

test("pipeline: a contradiction with an earlier answer after two rounds is decided and listed", async () => {
  const { p, m } = await settled(
    reply(
      {
        ...DESIGN,
        open_questions: [
          { question: "Contradiction: you said English only, but the copy is in French.", answer: null },
        ],
        pr: `Greets.\n\n${DECISIONS}`,
      },
      specOf(3),
    ),
    [],
  );
  expect(m.stage, p.moves()).toBe("done");
  expect(designs(p)[2]!.prompt).toContain("contradicts an earlier answer");
  expect(data(m).design?.open).toEqual([]);
  expect(p.prNo("web", m.spec_pr!).body).toContain(DECISIONS);
}, 60_000);

test("pipeline: after two rounds the spec gate ignores new open points", async () => {
  const { p, m } = await settled(reply(DESIGN, specOf(3)), [point("Which colour?")]);
  expect(m.stage, p.moves()).toBe("done");
  expect(data(m).risk?.spec?.openPoints).toEqual([]);
  expect(p.prNo("web", m.spec_pr!).body).not.toContain("Open points for you");
  const third = p.claudeCalls.filter((c) => c.kind === "risk")[2]!;
  expect(third.prompt).toContain("it is settled");
}, 60_000);

test("pipeline: before two rounds open questions still go to the owner", async () => {
  const p = start([point(ASKED)], [point("Which font?")]);
  await p.start();
  await p.untilStage("approval:spec");
  const m = await answer(
    p,
    "English only.",
    reply({ ...DESIGN, open_questions: [{ question: ASKED, answer: null }] }),
  );
  expect(m.stage, p.moves()).toBe("approval:spec");
  expect(m.why).toBe("The spec leaves one question for you to settle before it is built.");
  expect(data(m).design?.open).toEqual([ASKED]);
  expect(designs(p)[1]!.prompt).not.toContain("it is settled");
  expect(p.claudeCalls.filter((c) => c.kind === "risk")[1]!.prompt).toContain(ASKED);
}, 60_000);

test("pipeline: after two rounds the reviewer may still raise an unsafe gap, labelled", async () => {
  const unsafe = point("Unsafe: data loss: the spec deletes every stored greeting.");
  const { p, m } = await settled(reply(DESIGN, specOf(3)), [unsafe]);
  expect(m.stage, p.moves()).toBe("approval:spec");
  expect(m.why).toBe("The spec leaves one question for you to settle before it is built.");
  expect(data(m).risk?.spec?.openPoints.map((x) => x.point)).toEqual([unsafe.point]);
  expect(p.prNo("web", m.spec_pr!).body).toContain("Open points for you");
}, 60_000);

test("pipeline: after two rounds an unlabelled reviewer point is dropped", async () => {
  const unsafe = point("Unsafe: security: anyone can edit the greeting.");
  const { p, m } = await settled(reply(DESIGN, specOf(3)), [point("Which colour?"), unsafe]);
  expect(m.stage, p.moves()).toBe("approval:spec");
  expect(data(m).risk?.spec?.openPoints.map((x) => x.point)).toEqual([unsafe.point]);
  expect(m.why).toBe("The spec leaves one question for you to settle before it is built.");
}, 60_000);

test("pipeline: the design never asks after two rounds, even for an unsafe gap", async () => {
  const { p, m } = await settled(
    reply(
      {
        ...DESIGN,
        open_questions: [{ question: "Unsafe: data loss: delete every greeting?", answer: null }],
        pr: `Greets.\n\n${DECISIONS}`,
      },
      specOf(3),
    ),
    [],
  );
  expect(m.stage, p.moves()).toBe("done");
  expect(designs(p)[2]!.prompt).toContain("don't ask");
  expect(data(m).design?.open).toEqual([]);
}, 60_000);
