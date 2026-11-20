// A failed job's own log for a repair round (PIP-154, PIP-155): which job to read, and the log cut
// to the finding without the secret.

/** The log is only cut when it is longer than the tail a repair round gets (PIP-83). */
export const LOG_TAIL = 6000;

/** The job id in a check's details URL (`…/actions/runs/<run>/job/<job>`, GitLab's `…/-/jobs/<job>`), or null. */
export function jobId(url: string): number | null {
  const m = /\/(?:job|-\/jobs)\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? Number(m[1]) : null;
}

/** A summary job (`ci-ok`) only reports that another job failed: its name's last segment is `ci-ok`. */
export function isSummary(name: string): boolean {
  return name.split(" / ").at(-1)?.trim() === "ci-ok";
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const STAMP = /^(?:.*?\t)?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;
const SECRET_LINE = /^\s*(?:##\[\w+\])?\s*(?:Secret|Match|Finding):/;
const GITLEAKS_LINE = /^\s*(?:RuleID|File|Line|Fingerprint):/;
const SEMGREP_START = /Code Finding|Findings:/;
const SEMGREP_END = /^\s*(?:Ran \d+ rules?\b|Scan Summary|Semgrep CLI)/;

/**
 * A job log without the lines that carry a secret (gitleaks' `Secret:`, `Match:`, `Finding:`), at
 * any length. A log over the tail limit is cut to gitleaks' RuleID/File/Line blocks or Semgrep's
 * findings block when one is found; otherwise it is left for the tail.
 */
export function cutLog(text: string): string {
  const lines = text
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.replace(STAMP, "").replace(/\r$/, ""))
    .filter((l) => !SECRET_LINE.test(l));
  const kept = lines.join("\n");
  if (kept.length <= LOG_TAIL) return kept;
  const leaks = lines.filter((l) => GITLEAKS_LINE.test(l));
  if (leaks.some((l) => /^\s*RuleID:/.test(l))) {
    return leaks
      .map((l) => (/^\s*RuleID:/.test(l) ? `\n${l.trim()}` : l.trim()))
      .join("\n")
      .trim();
  }
  const from = lines.findIndex((l) => SEMGREP_START.test(l));
  if (from >= 0) {
    const rest = lines.slice(from);
    const to = rest.findIndex((l, i) => i > 0 && SEMGREP_END.test(l));
    return (to < 0 ? rest : rest.slice(0, to)).join("\n").trim();
  }
  return kept;
}
