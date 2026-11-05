// Code scanning alerts in the repair round (PIP-148..150): a red `CodeQL` check has no Actions run,
// so the repair details carry the open alerts of the PR's changed files, or say why they can't.

import { expect, test } from "vitest";
import { settingsCommand } from "../../src/cli.ts";
import { scanningPermissionMissing } from "../../src/pipeline/alerts.ts";
import { build, CODE, checkRun, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const ALERT = {
  rule: "js/incomplete-url-substring-sanitization",
  path: "tests/gitlab/fake.test.ts",
  line: 23,
  message: "'gitlab.com' may be at an arbitrary position in the sanitized URL.",
};
const LINE = `- ${ALERT.rule} at ${ALERT.path}:${ALERT.line}: ${ALERT.message}`;

/** CodeQL is a code scanning result: its link is not an Actions run. */
const codeql = () => ({
  ...checkRun("CodeQL", "FAILURE"),
  detailsUrl: "https://github.com/owner/web/runs/999",
});

type Setup = (p: Pipe) => void;
type Mid = (p: Pipe) => void;

/** A code PR whose every head is red on `checks`; runs until the owner is asked, `mid` after the first repair. */
async function flow(setup: Setup, checks: () => unknown[], mid?: Mid): Promise<Pipe> {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  let round = 0;
  p.respond.worker = () => {
    round++;
    return {
      structured: build(),
      edits: round === 1 ? CODE : { "greeting.txt": `hello, try ${round}\n` },
    };
  };
  p.changedFiles = ["greeting.txt", ALERT.path];
  setup(p);
  await p.start();
  let ticked = false;
  await p.until(() => {
    const code = p.prs.find((x) => x.head === `towercab/${ID}-${SLUG}`);
    if (code) code.checks = () => checks();
    if (mid && !ticked && p.claudeCalls.filter((c) => c.kind === "worker").length >= 2) {
      ticked = true;
      mid(p);
    }
    return p.mission()?.stage === "blocked";
  });
  return p;
}

const repairs = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "worker").slice(1);

test("pipeline: a red CodeQL check without a run gives the repair round the alert's rule, file and line", async () => {
  const p = await flow(
    (x) => {
      x.alerts = [ALERT];
    },
    () => [codeql()],
  );
  try {
    expect(repairs(p)).toHaveLength(2);
    for (const r of repairs(p)) {
      expect(r.prompt).toContain("- CodeQL: failure https://github.com/owner/web/runs/999");
      expect(r.prompt).toContain(LINE);
    }
    expect(p.alertReads[0]).toMatch(
      /^repos\/owner\/web\/code-scanning\/alerts\?ref=refs\/pull\/\d+\/merge&state=open&per_page=100$/,
    );
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a check with a run log gets no alert block", async () => {
  const p = await flow(
    (x) => {
      x.alerts = [ALERT];
    },
    () => [checkRun("test", "FAILURE", 300)],
  );
  try {
    expect(repairs(p)).toHaveLength(2);
    for (const r of repairs(p)) {
      expect(r.prompt).toContain("Error: a test failed");
      expect(r.prompt).not.toContain("Code scanning alerts");
    }
    expect(p.alertReads).toEqual([]);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: alerts in files the pull request did not change are left out", async () => {
  const many = Array.from({ length: 22 }, (_, i) => ({ ...ALERT, line: 100 + i }));
  const p = await flow(
    (x) => {
      x.alerts = [{ ...ALERT, path: "src/old.ts", line: 7 }, ALERT, ...many];
    },
    () => [codeql()],
  );
  try {
    const prompt = repairs(p)[0]!.prompt;
    expect(prompt).toContain(LINE);
    expect(prompt).not.toContain("src/old.ts");
    // 23 alerts in changed files: 20 are listed, the rest counted.
    expect(prompt).toContain("and 3 more");
    expect(prompt.match(/^- js\/incomplete-url/gm)).toHaveLength(20);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: unreadable code scanning alerts are noted in the repair details", async () => {
  const p = await flow(
    (x) => {
      x.alertsFail = "gh: Bad gateway (HTTP 502)";
    },
    () => [codeql()],
  );
  try {
    expect(repairs(p)).toHaveLength(2);
    expect(repairs(p)[0]!.prompt).toContain(
      "(the code scanning alerts couldn't be read: gh: Bad gateway (HTTP 502))",
    );
    expect(scanningPermissionMissing(p.db)).toBe(false);
    expect(p.mission()!.waiting).toBe("CI red");
  } finally {
    p.cleanup();
  }
}, 60_000);

const NEEDS =
  "(the code scanning alerts couldn't be read: the GitHub App needs the Code scanning alerts: read permission)";

test("pipeline: a refused alert read names the missing permission", async () => {
  const p = await flow(
    (x) => {
      x.alertsDenied = true;
    },
    () => [codeql()],
  );
  try {
    expect(repairs(p)).toHaveLength(2);
    expect(repairs(p)[0]!.prompt).toContain(NEEDS);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a refused alert read becomes one owner step", async () => {
  const p = await flow(
    (x) => {
      x.alertsDenied = true;
    },
    () => [codeql()],
  );
  try {
    expect(scanningPermissionMissing(p.db)).toBe(true);
    expect(p.db.all("SELECT key FROM meta WHERE key = 'code-scanning-permission'")).toHaveLength(1);
    // The mission is not held by it: the repair rounds ran.
    expect(repairs(p)).toHaveLength(2);
    const w = { db: p.db } as Parameters<typeof settingsCommand>[0];
    expect(await settingsCommand(w, ["scanning-granted"])).toMatch(/reads code scanning alerts again/);
    expect(scanningPermissionMissing(p.db)).toBe(false);
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a refused alert read is not retried until the step is ticked", async () => {
  const p = await flow(
    (x) => {
      x.alertsDenied = true;
    },
    () => [codeql()],
    (x) => {
      // Between the first and the second repair: one read was refused and none since.
      expect(x.alertReads).toHaveLength(1);
      expect(scanningPermissionMissing(x.db)).toBe(true);
      const w = { db: x.db } as Parameters<typeof settingsCommand>[0];
      void settingsCommand(w, ["scanning-granted"]);
      x.alertsDenied = false;
      x.alerts = [ALERT];
    },
  );
  try {
    // One refused read, then (the step ticked) a read for the second repair and one when the owner is asked.
    expect(p.alertReads).toHaveLength(3);
    expect(repairs(p)[0]!.prompt).toContain(NEEDS);
    expect(repairs(p)[1]!.prompt).toContain(LINE);
  } finally {
    p.cleanup();
  }
}, 60_000);
