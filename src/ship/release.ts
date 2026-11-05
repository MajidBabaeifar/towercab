// What Towercab does with a release-please pull request (SHIP-30, SHIP-31): pure rules over plain
// data; `releases.ts` reads GitHub and acts on the decision.

/** One file of the PR's diff (`pulls/<n>/files`). `patch` is missing for files GitHub won't diff. */
export interface PrFile {
  name: string;
  patch: string | null;
}

/** The checks of main's head commit, already judged against the required ones. */
export interface MainChecks {
  state: "green" | "pending" | "red" | "none";
  /** Names of the checks that are not green (or "" when there are none at all). */
  names: string[];
}

export interface ReleaseInput {
  /** `releases: manual` in TOWERCAB.md. */
  manual: boolean;
  files: PrFile[];
  /** `extra-files` paths of the default branch's `release-please-config.json`. */
  extraFiles: string[];
  /** The PR body. */
  body: string;
  /** The PR is not based on the current head of the default branch. */
  stale: boolean;
  checks: MainChecks;
}

/** Why a PR is held. `files`, `major`, `breaking` and `manual` raise a card at once; the rest after a day. */
export type HoldReason = "manual" | "files" | "major" | "breaking" | "stale" | "checks";

export type Decision =
  | { kind: "merge" }
  | { kind: "hold"; reason: HoldReason; why: string; title: string; immediate: boolean };

export const DAY_S = 86_400;

const VERSION_FILES = new Set([
  "package.json",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "version.txt",
]);
const SEMVER = /\d+\.\d+\.\d+/;
const VERSION_KEY = /^\s*"?version"?\s*[:=]/i;

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const clean = (path: string) => path.replace(/^\.\//, "");

/** The changed lines of a unified diff, without the `+++`/`---` headers. */
function changed(patch: string): { sign: "+" | "-"; text: string }[] {
  const out: { sign: "+" | "-"; text: string }[] = [];
  for (const l of patch.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) out.push({ sign: "+", text: l.slice(1) });
    else if (l.startsWith("-")) out.push({ sign: "-", text: l.slice(1) });
  }
  return out;
}

/** Is this file a release file whose changed lines touch only what a release changes? */
export function isReleaseFile(file: PrFile, extraFiles: string[]): boolean {
  const name = clean(file.name);
  const b = base(name);
  if (b === "CHANGELOG.md" || b === ".release-please-manifest.json") return true;
  const extra = extraFiles.map(clean).includes(name);
  if (!VERSION_FILES.has(b) && !extra) return false;
  if (file.patch === null) return false;
  const lines = changed(file.patch);
  if (b === "version.txt") return lines.every((l) => l.text.trim() === "" || SEMVER.test(l.text));
  if (VERSION_FILES.has(b)) return lines.every((l) => VERSION_KEY.test(l.text));
  return lines.every((l) => SEMVER.test(l.text));
}

const SEMVERS = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g;

/** The versions a changed line names. */
const versionsOf = (text: string): string[] => text.match(SEMVERS) ?? [];

/**
 * Version files whose changed lines name a version the release doesn't bump: a dependency's
 * `version` line in a lock file, say. The release's versions are the ones the manifest diff names;
 * without a manifest in the diff, all version files may bump one old and one new version only.
 */
export function foreignVersionFiles(files: PrFile[], extraFiles: string[]): string[] {
  const extra = extraFiles.map(clean);
  const versioned = files.filter((f) => {
    const b = base(clean(f.name));
    return f.patch !== null && (VERSION_FILES.has(b) || extra.includes(clean(f.name)));
  });
  const manifest = files.find((f) => base(f.name) === ".release-please-manifest.json");
  const allowed = new Set(
    (manifest?.patch ? changed(manifest.patch) : []).flatMap((l) => versionsOf(l.text)),
  );
  const lines = (f: PrFile) => changed(f.patch!).filter((l) => versionsOf(l.text).length > 0);
  if (allowed.size > 0) {
    return versioned
      .filter((f) => lines(f).some((l) => versionsOf(l.text).some((v) => !allowed.has(v))))
      .map((f) => f.name);
  }
  const olds = new Set<string>();
  const news = new Set<string>();
  for (const f of versioned) {
    for (const l of lines(f)) for (const v of versionsOf(l.text)) (l.sign === "-" ? olds : news).add(v);
  }
  return olds.size > 1 || news.size > 1 ? versioned.map((f) => f.name) : [];
}

/** The paths in the diff that are not release files. */
export function extraPaths(files: PrFile[], extraFiles: string[]): string[] {
  return files.filter((f) => !isReleaseFile(f, extraFiles)).map((f) => f.name);
}

const major = (v: string): number => Number(/^v?(\d+)/.exec(v.trim())?.[1] ?? Number.NaN);

/** `old → new` of the first package of the manifest diff whose major number goes up, or null. */
export function majorJump(files: PrFile[]): string | null {
  const manifest = files.find((f) => base(f.name) === ".release-please-manifest.json");
  if (!manifest?.patch) return null;
  const entry = /^\s*"([^"]*)"\s*:\s*"([^"]*)"/;
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const l of changed(manifest.patch)) {
    const m = entry.exec(l.text);
    if (m) (l.sign === "-" ? before : after).set(m[1]!, m[2]!);
  }
  for (const [pkg, to] of after) {
    const from = before.get(pkg);
    if (from !== undefined && major(to) > major(from)) return `${from} → ${to}`;
  }
  return null;
}

const BANG = /\b(?:feat|fix|perf|refactor|docs|chore|build|ci|test|style|revert)(?:\([^)]*\))?!:/i;

/** The first breaking entry in the PR body or the lines added to a changelog, or null. */
export function isBreaking(body: string, files: PrFile[]): string | null {
  const added = files
    .filter((f) => base(f.name) === "CHANGELOG.md" && f.patch)
    .flatMap((f) =>
      changed(f.patch!)
        .filter((l) => l.sign === "+")
        .map((l) => l.text),
    );
  const lines = [...body.split("\n"), ...added];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/BREAKING CHANGES?/i.test(l) && /^\s*#+/.test(l)) {
      const entry = lines.slice(i + 1).find((x) => /^\s*[*-]\s/.test(x));
      return (entry ?? l).replace(/^\s*(#+|[*-])\s*/, "").trim();
    }
    if (BANG.test(l)) return l.replace(/^\s*[*-]\s*/, "").trim();
  }
  return null;
}

/** What to do with the release PR (SHIP-30, SHIP-31). */
export function decideRelease(i: ReleaseInput): Decision {
  const hold = (reason: HoldReason, title: string, why: string, immediate: boolean): Decision => ({
    kind: "hold",
    reason,
    title,
    why,
    immediate,
  });
  if (i.manual) return hold("manual", "needs you", "This repo merges its releases by hand.", true);
  const extra = extraPaths(i.files, i.extraFiles);
  if (extra.length) {
    return hold("files", "needs you", `The release also changes: ${extra.join(", ")}.`, true);
  }
  const foreign = foreignVersionFiles(i.files, i.extraFiles);
  if (foreign.length) {
    return hold(
      "files",
      "needs you",
      `The release changes versions it doesn't release in: ${foreign.join(", ")}.`,
      true,
    );
  }
  const jump = majorJump(i.files);
  if (jump) return hold("major", "needs you", `Major release ${jump}.`, true);
  const breaking = isBreaking(i.body, i.files);
  if (breaking) return hold("breaking", "needs you", `Breaking change: ${breaking}`, true);
  if (i.stale) {
    return hold(
      "stale",
      "has waited a day",
      "It is behind main and release-please has not updated it.",
      false,
    );
  }
  if (i.checks.state === "none") {
    return hold("checks", "has waited a day", "This repo runs no checks on main.", false);
  }
  if (i.checks.state !== "green") {
    const what = i.checks.state === "red" ? "red" : "still running";
    return hold(
      "checks",
      "has waited a day",
      `Checks on main are ${what}: ${i.checks.names.join(", ")}.`,
      false,
    );
  }
  return { kind: "merge" };
}
