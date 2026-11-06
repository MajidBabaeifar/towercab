// A repair round reads the log of the job that failed, cut around the finding and never holding a
// secret (PIP-154, PIP-155, PIP-156).

import { expect, test } from "vitest";
import type { Check } from "../../src/forge.ts";
import type { Ctx } from "../../src/handlers.ts";
import { redLog } from "../../src/pipeline/ci.ts";
import { cutLog } from "../../src/pipeline/job-log.ts";
import { FakeForge } from "../helpers/fake-forge.ts";

const REPO = "me/web";
const SECRET = "AKIAFAKESECRETVALUE123";

/** Only the summary job's line, as `--log-failed` gives for the shared reusable workflows. */
class SummaryOnly extends FakeForge {
  override async failedLog(_repo: string, run: number) {
    return `ci-ok\tFail if a job failed\t2026-11-05T21:00:00.0000000Z a job ended failure (run ${run})\n`;
  }
}

function check(name: string, run: number | null, job: number | null): Check {
  return {
    name,
    kind: "run",
    status: "COMPLETED",
    conclusion: "FAILURE",
    startedAt: null,
    run,
    url:
      run === null
        ? ""
        : `https://github.com/${REPO}/actions/runs/${run}${job === null ? "" : `/job/${job}`}`,
  };
}

/** The repair details `redLog` builds for a PR whose checks are `checks`. */
async function details(forge: FakeForge, checks: Check[]): Promise<string> {
  const n = await forge.openPr(REPO, { base: "main", head: "b", title: "t", body: "" });
  forge.prs[0]!.checks = checks;
  const cx = {
    github: forge,
    clock: { now: () => 1000 },
    config: { agent: { ciGrace: 0 } },
  } as unknown as Ctx;
  return (await redLog(cx, REPO, n, 0)) ?? "";
}

const stamp = (line: string) => `2026-11-05T21:00:00.0000000Z ${line}`;
const noise = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    stamp(`step ${i}: downloading and scanning the checkout, nothing here`),
  );

function gitleaksLog(): string {
  const finding = (rule: string, file: string, line: number) => [
    stamp(`Finding:     key = "${SECRET}"`),
    stamp(`Secret:      ${SECRET}`),
    stamp(`RuleID:      ${rule}`),
    stamp("Entropy:     4.2"),
    stamp(`File:        ${file}`),
    stamp(`Line:        ${line}`),
    stamp(`Fingerprint: ${file}:${rule}:${line}`),
    "",
  ];
  return [
    ...noise(150),
    ...finding("generic-api-key", "src/config.ts", 12),
    ...finding("aws-access-token", "deploy/env.sh", 3),
    ...noise(10),
  ].join("\n");
}

function semgrepLog(): string {
  return [
    ...noise(150),
    "┌─────────────────┐",
    "│ 2 Code Findings │",
    "└─────────────────┘",
    "    src/app.ts",
    "    ❯❱ javascript.express.security.audit.xss.direct-response-write",
    "          Detected directly writing to a Response object.",
    "           12┆ res.send(req.query.name)",
    "    src/db.ts",
    "    ❯❱ javascript.sequelize.security.audit.sequelize-injection",
    "           30┆ db.query(`select ${id}`)",
    "",
    "Ran 120 rules on 40 files: 2 findings.",
    ...noise(10),
  ].join("\n");
}

test("pipeline: a red run whose failed log is only the summary job gives the repair round the failed job's finding", async () => {
  const forge = new SummaryOnly();
  forge.jobLogs.set(7, stamp("Error: gitleaks found RuleID: generic-api-key in src/config.ts line 12"));
  forge.jobLogs.set(8, stamp("a job ended failure"));
  const out = await details(forge, [check("checks / secrets", 42, 7), check("checks / ci-ok", 42, 8)]);
  expect(out).toContain("Job checks / secrets:");
  expect(out).toContain("generic-api-key in src/config.ts line 12");
  expect(out).not.toContain("a job ended failure");
});

test("pipeline: summary jobs are skipped when another check failed", async () => {
  const forge = new SummaryOnly();
  forge.jobLogs.set(7, "semgrep found one thing");
  forge.jobLogs.set(8, "summary job log");
  const out = await details(forge, [check("ci-ok", 42, 8), check("SAST / semgrep", 42, 7)]);
  expect(out).toContain("Job SAST / semgrep:\nsemgrep found one thing");
  expect(out).not.toContain("summary job log");
  expect(out).not.toContain("a job ended failure");
});

test("pipeline: a check without a job id in its URL keeps the run log", async () => {
  const forge = new SummaryOnly();
  const out = await details(forge, [check("test", 42, null)]);
  expect(out).toContain("a job ended failure (run 42)");
  expect(out).not.toContain("Job test:");
  // Only summary jobs failed: the run log is read as before.
  forge.jobLogs.set(8, "summary job log");
  const only = await details(new SummaryOnly(), [check("checks / ci-ok", 43, 8)]);
  expect(only).toContain("a job ended failure (run 43)");
});

test("pipeline: an unreadable job log is noted and the run log is used", async () => {
  const forge = new SummaryOnly();
  const out = await details(forge, [check("checks / secrets", 42, 7)]);
  expect(out).toContain("(the log of job checks / secrets couldn't be read: gh api: Not Found (HTTP 404))");
  expect(out).toContain("a job ended failure (run 42)");
});

test("pipeline: a long gitleaks log is cut to its RuleID, File and Line blocks", async () => {
  const forge = new SummaryOnly();
  forge.jobLogs.set(7, gitleaksLog());
  const out = await details(forge, [check("checks / secrets", 42, 7)]);
  expect(out).toContain("RuleID:      generic-api-key");
  expect(out).toContain("File:        src/config.ts");
  expect(out).toContain("Line:        12");
  expect(out).toContain("RuleID:      aws-access-token");
  expect(out).toContain("File:        deploy/env.sh");
  expect(out).not.toContain("downloading and scanning");
});

test("pipeline: a gitleaks secret value never reaches the repair details", async () => {
  const forge = new SummaryOnly();
  forge.jobLogs.set(7, gitleaksLog());
  forge.jobLogs.set(
    9,
    [stamp(`Secret:      ${SECRET}`), stamp("RuleID:      generic-api-key"), stamp("File:        a.ts")].join(
      "\n",
    ),
  );
  const long = await details(forge, [check("checks / secrets", 42, 7)]);
  expect(long).not.toContain(SECRET);
  const second = new SummaryOnly();
  second.jobLogs.set(9, forge.jobLogs.get(9)!);
  const short = await details(second, [check("checks / secrets", 43, 9)]);
  expect(short).toContain("RuleID:      generic-api-key");
  expect(short).toContain("File:        a.ts");
  expect(short).not.toContain(SECRET);
});

test("pipeline: a long Semgrep log is cut to its findings block", async () => {
  const forge = new SummaryOnly();
  forge.jobLogs.set(7, semgrepLog());
  const out = await details(forge, [check("SAST / semgrep", 42, 7)]);
  expect(out).toContain("2 Code Findings");
  expect(out).toContain("javascript.express.security.audit.xss.direct-response-write");
  expect(out).toContain("src/db.ts");
  expect(out).not.toContain("downloading and scanning");
});

test("pipeline: a log without a known finding block keeps its tail", async () => {
  const text = `${noise(300).join("\n")}\n${stamp("the last line")}`;
  expect(cutLog(text).endsWith("the last line")).toBe(true);
  const forge = new SummaryOnly();
  forge.jobLogs.set(7, text);
  const out = await details(forge, [check("build", 42, 7)]);
  expect(out).toContain("the last line");
  expect(out.length).toBeLessThan(7000);
});
