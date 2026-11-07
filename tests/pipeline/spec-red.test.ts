// A red spec PR is revised once by the design, and every design revision on a red spec PR sees the
// failing logs (PIP-82, PIP-83).

import { expect, test } from "vitest";
import { checkRun, DESIGN, happy, intent, intents, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const REVISED = { "specs/web.md": `${SPEC["specs/web.md"]}\nAn empty page says hello too.\n` };

/** Spec checks that fail on the first head (run 42) and pass on every head after it. */
function redOnFirstHead(p: Pipe): void {
  let first = "";
  p.newPrChecks = (pr, head) => {
    if (!pr.head.endsWith("-spec")) return [];
    first ||= head;
    return [head === first ? checkRun("spec-check", "FAILURE", 42) : checkRun("spec-check", "SUCCESS", 43)];
  };
}

const designs = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "design");

async function flow(a: number, run: (p: Pipe) => Promise<void>): Promise<void> {
  const p = new Pipe(TARGET, intents(intent({ a })), { keep: true });
  try {
    happy(p);
    await run(p);
  } finally {
    p.cleanup();
  }
}

test(
  "pipeline: a red spec PR is revised once",
  () =>
    flow(5, async (p) => {
      redOnFirstHead(p);
      p.script(reply(DESIGN, SPEC), reply(DESIGN, REVISED));
      await p.start();
      const m = await p.untilStage("plan");
      // The first red was rerun, then the design revised the spec in its session; the revised head
      // passed and Towercab merged the spec PR itself (a5).
      expect(p.reruns).toEqual([42]);
      const [first, second] = designs(p);
      expect(designs(p)).toHaveLength(2);
      expect(second!.session).toEqual({ mode: "resume", id: first!.session.id });
      expect(second!.prompt).toContain("The checks on the spec PR are failing");
      expect(second!.prompt).not.toContain("The owner commented");
      const pr = p.prNo("web", m.spec_pr!);
      expect(pr.state).toBe("MERGED");
      expect(p.prs.filter((x) => x.repo === "owner/web")).toHaveLength(1);
      expect(JSON.parse(m.data).specRedRevisions).toBe(1);
    }),
  60_000,
);

test(
  "pipeline: a red spec PR that stays red waits for the owner",
  () =>
    flow(5, async (p) => {
      p.newPrChecks = (pr) => (pr.head.endsWith("-spec") ? [checkRun("spec-check", "FAILURE", 42)] : []);
      await p.start();
      const m = await p.untilStage("approval:spec");
      // One revision only; then the owner is asked, and the reason names the red check.
      expect(designs(p)).toHaveLength(2);
      expect(m.waiting).toBe("approve spec");
      expect(m.why).toContain("still fail after one revision");
      expect(m.why).toContain("spec-check");
      expect(p.prNo("web", m.spec_pr!).state).toBe("OPEN");
      expect(p.forge.calls.some((l) => l.startsWith("merge "))).toBe(false);
      expect(JSON.parse(m.data).specRedRevisions).toBe(1);
    }),
  60_000,
);

test(
  "pipeline: a red spec PR waiting for approval is revised first",
  () =>
    flow(2, async (p) => {
      redOnFirstHead(p);
      p.script(reply(DESIGN, SPEC), reply(DESIGN, REVISED));
      await p.start();
      const m = await p.untilStage("approval:spec");
      // The owner is asked once, about the revised (green) spec PR, never about the red one.
      expect(designs(p)).toHaveLength(2);
      expect(p.stages(m.id)).toEqual(["design", "approval:spec"]);
      expect(p.show("web", p.prNo("web", m.spec_pr!).head, "specs/web.md")).toContain("An empty page");
      expect(m.waiting).toBe("approve spec");
    }),
  60_000,
);

/** An a2 mission waiting for the owner on a spec PR, then the owner's comment on `head`'s red checks. */
async function commentOnRed(p: Pipe, red: boolean): Promise<void> {
  p.script(reply(DESIGN, SPEC), reply(DESIGN, REVISED));
  await p.start();
  const m = await p.untilStage("approval:spec");
  const pr = p.prNo("web", m.spec_pr!);
  const head = p.headSha("owner/web", pr.head);
  pr.checks = (_, h) => [
    h === head && red ? checkRun("spec-check", "FAILURE", 44) : checkRun("spec-check", "SUCCESS", 45),
  ];
  p.ownerComment(pr, "Please also say what happens on an empty page.");
  p.clock.advance(61);
  await p.until(() => designs(p).length === 2);
  await p.untilStage("approval:spec");
}

test(
  "pipeline: a design revision gets the failing logs",
  () =>
    flow(2, async (p) => {
      await commentOnRed(p, true);
      const prompt = designs(p)[1]!.prompt;
      expect(prompt).toContain("Please also say what happens on an empty page.");
      expect(prompt).toContain("<ci-log>");
      expect(prompt).toContain("- spec-check: failure");
      expect(prompt).toContain("run 44: Error: a test failed");
      expect(prompt).toContain("say so in `concerns`");
    }),
  60_000,
);

test(
  "pipeline: a design revision without red checks has no log section",
  () =>
    flow(2, async (p) => {
      await commentOnRed(p, false);
      const prompt = designs(p)[1]!.prompt;
      expect(prompt).toContain("Please also say what happens on an empty page.");
      expect(prompt).not.toContain("<ci-log>");
    }),
  60_000,
);

test(
  "pipeline: an unreadable log does not stop the revision",
  () =>
    flow(2, async (p) => {
      p.runViewFails = true;
      await commentOnRed(p, true);
      const prompt = designs(p)[1]!.prompt;
      expect(prompt).toContain("<ci-log>");
      expect(prompt).toContain("the log of run 44 couldn't be read");
      expect(p.mission()!.stage).toBe("approval:spec");
    }),
  60_000,
);
