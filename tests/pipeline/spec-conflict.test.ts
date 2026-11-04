// A spec PR that conflicts with main is revised by itself, twice at most, before the owner is asked
// (PIP-133); a revision that alters a row main changed is not pushed.

import { expect, test } from "vitest";
import { DESIGN, happy, intent, intents, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const MAIN_ROW = "### WEB-9 · From main\n\nMain's row.\n";

/**
 * Makes the spec PR conflict while `on()` holds; main gets `files` the first time anyone asks GitHub,
 * after the design branch exists.
 */
function conflictWhile(p: Pipe, files: Record<string, string>, on: () => boolean): void {
  let pushed = false;
  const push = p.prs.push.bind(p.prs);
  p.prs.push = (...xs) => {
    for (const x of xs) {
      if (x.repo !== "owner/web") continue;
      Object.defineProperty(x, "mergeable", {
        configurable: true,
        get: () => {
          if (!pushed) {
            pushed = true;
            p.pushTo("web", "main", files, "docs(specs): other");
          }
          return on() ? "CONFLICTING" : "MERGEABLE";
        },
        set: () => {},
      });
    }
    return push(...xs);
  };
}

/** The first design writes `first`; every revision for the clash writes `revision`. */
function writes(p: Pipe, first: Record<string, string>, revision: Record<string, string>): void {
  p.respond.design = (spec, prompt) =>
    reply(DESIGN, prompt.includes("conflicts with the base branch") ? revision : first)(spec, prompt);
}

const designs = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "design");

test("pipeline: a conflicting spec PR is revised without asking", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    conflictWhile(p, { "specs/web.md": `# Web\n\n${MAIN_ROW}` }, () => designs(p).length < 2);
    writes(p, SPEC, { "specs/web.md": `${SPEC["specs/web.md"]}\n${MAIN_ROW}` });
    await p.start();
    const m = await p.untilStage("approval:spec");
    expect(designs(p)).toHaveLength(2);
    // The owner was never asked about the clash: the revision ran inside the design stage.
    expect(p.stages(m.id)).toEqual(["design", "approval:spec"]);
    const prompt = designs(p)[1]!.prompt;
    expect(prompt).toContain("conflict markers to resolve (keep both sides' rows): specs/web.md.");
    expect(prompt).toContain("renumber this PR's rows");
    // One PR; its head carries both rows and no markers.
    expect(p.prs.filter((x) => x.repo === "owner/web")).toHaveLength(1);
    const file = p.show("web", p.prNo("web", m.spec_pr!).head, "specs/web.md");
    expect(file).toContain("WEB-1");
    expect(file).toContain("WEB-9");
    expect(file).not.toContain("<<<<<<<");
    expect(JSON.parse(m.data).specConflicts).toBe(1);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a spec conflict that stays after two revisions waits for the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    conflictWhile(p, { "specs/web.md": `# Web\n\n${MAIN_ROW}` }, () => true);
    writes(p, SPEC, { "specs/web.md": `${SPEC["specs/web.md"]}\n${MAIN_ROW}` });
    await p.start();
    const blocked = await p.untilStage("blocked", 90);
    expect(blocked.waiting).toBe("spec conflict");
    expect(designs(p)).toHaveLength(3);
    expect(JSON.parse(blocked.data).specConflicts).toBe(2);
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a revision that changes a row main changed waits for the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    conflictWhile(p, { "specs/web.md": `# Web\n\n${MAIN_ROW}` }, () => designs(p).length < 2);
    // The revision keeps WEB-1 but rewrites main's WEB-9.
    writes(p, SPEC, {
      "specs/web.md": `${SPEC["specs/web.md"]}\n### WEB-9 · From main\n\nRewritten by the revision.\n`,
    });
    await p.start();
    const blocked = await p.untilStage("blocked");
    expect(blocked.waiting).toBe("spec conflict");
    expect(blocked.why).toContain("WEB-9");
    // Nothing was pushed: the spec PR still has the first design.
    const head = p.prNo("web", blocked.spec_pr!).head;
    expect(p.show("web", head, "specs/web.md")).not.toContain("Rewritten");
    expect(p.show("web", head, "specs/web.md")).not.toContain("WEB-9");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a row the PR itself amended may be kept", async () => {
  const BASE = "# Web\n\n### WEB-1 · A\n\nOne.\n\n### WEB-2 · B\n\nTwo.\n";
  const p = new Pipe({ ...TARGET, "specs/web.md": BASE }, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    // Main edits the same line of WEB-1 and also WEB-2.
    conflictWhile(
      p,
      { "specs/web.md": BASE.replace("One.", "Uno.").replace("Two.", "Dos.") },
      () => designs(p).length < 2,
    );
    // The revision keeps this PR's WEB-1 and takes main's WEB-2.
    writes(
      p,
      { "specs/web.md": BASE.replace("One.", "One, amended.") },
      { "specs/web.md": BASE.replace("One.", "One, amended.").replace("Two.", "Dos.") },
    );
    await p.start();
    const m = await p.untilStage("approval:spec");
    expect(designs(p)).toHaveLength(2);
    const file = p.show("web", p.prNo("web", m.spec_pr!).head, "specs/web.md");
    expect(file).toContain("One, amended.");
    expect(file).toContain("Dos.");
    expect(file).not.toContain("<<<<<<<");
  } finally {
    p.cleanup();
  }
}, 60_000);
