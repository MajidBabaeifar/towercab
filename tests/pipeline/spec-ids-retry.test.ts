// A fresh attempt after the intent's own spec merged must not move its reserved IDs (PIP-131).

import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { DESIGN, DIR, happy, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

test("pipeline: a retry after the spec merged keeps the reserved IDs", async () => {
  const merged = "### WEB-1 · Greeting\n\nThe page says hello.\n";
  const text = intent({
    a: 2,
    body: "- spec IDs: WEB-1\n",
    extra: "spec_pr: https://github.com/owner/web/pull/5\n",
  });
  const p = new Pipe({ ...TARGET, "specs/web.md": `# Web\n\n${merged}` }, intents(text), { keep: true });
  try {
    happy(p);
    p.respond.design = reply({ ...DESIGN, spec_ids: ["WEB-1"] }, { "specs/web.md": `# Web\n\n${merged}` });
    await p.start();
    await p.until(() => p.claudeCalls.some((c) => c.kind === "design"));
    expect(p.claudeCalls.find((c) => c.kind === "design")!.prompt).toContain(
      "Use only these reserved requirement IDs: WEB-1.",
    );
    expect(p.show("intents", "main", `${DIR}/intent.md`)).toContain("- spec IDs: WEB-1\n");
    const log = execFileSync("git", ["-C", p.bares.intents!, "log", "--format=%s", "main"], {
      encoding: "utf8",
    });
    expect(log).not.toContain("renumber spec IDs");
    expect(JSON.parse(p.mission()!.data).idsRenumbered).toBeUndefined();
  } finally {
    p.cleanup();
  }
}, 60_000);
