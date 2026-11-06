// Drafting a verifying section for a repo that has none (REPO-34): pure functions over the base
// branch's file list and the text of the few files they read. Nothing here runs a command or touches disk.

import picomatch from "picomatch";
import { DEFAULT_TESTS } from "./files.ts";

/** One line of a draft and the file it came from. */
export interface Evidence {
  line: string;
  from: string;
}

export interface Draft {
  /** Plain name of the source, for the PR and the owner's ask: `package.json scripts`. */
  source: string;
  setup: string[];
  checks: string[];
  evidence: Evidence[];
  /** What these checks leave out, in plain words. */
  notCovered: string[];
  /** The check lines that read the repo's own files (REPO-35); the guarded test folder line is not one. */
  substantive: string[];
}

export interface DraftInput {
  /** Every path on the base branch. */
  paths: string[];
  /** The text of the files the drafter reads, by path (absent → not on the base). */
  texts: Record<string, string>;
  /** `TOWERCAB.md` `tests`, or the defaults. */
  tests?: string[];
  /** Interpreters the sandbox has. */
  has: { python3: boolean; node: boolean };
}

/** Max drafts tried (REPO-35). */
export const MAX_DRAFTS = 3;

const DENY: RegExp[] = [
  /\b(npm|yarn|pnpm|bun)\s+(publish|login|adduser|whoami|token)\b/,
  /\bcargo\s+(publish|login)\b/,
  /\b(twine|poetry)\s+(upload|publish)\b/,
  /\bdocker\s+(push|login)\b/,
  /\b(kubectl|helm|terraform|ansible|ansible-playbook|aws|gcloud|az|gh|flyctl|vercel|netlify|wrangler|firebase|heroku|sops)\b/,
  /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|ftp|telnet)\b/,
  /\bgit\s+(push|remote|config|credential)\b/,
  /\bsudo\b/,
  /\b(deploy\w*|publish\w*|release\w*|upload\w*)\b/i,
  /\bsecrets?\./i,
  /\$\{\{/,
  /\$\{?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)\b/i,
];

/** Installs belong in `setup`: checks run without network. */
const INSTALL =
  /^\s*(npm\s+(ci|install|i)|yarn(\s+install)?|pnpm\s+(install|i)|bun\s+install|pip3?\s+install|python3?\s+-m\s+pip\s+install|cargo\s+fetch|go\s+mod\s+download|bundle\s+install|poetry\s+install|uv\s+sync)\b/;

/**
 * REPO-34: may this line be in a drafted block? A deny-list of what deploys, publishes, writes over the
 * network or uses a secret; in `checks` an install is refused too (it needs the network). The checks run
 * without network, which is the real guard; this keeps such a line out of the PR.
 */
export function commandIsCheckOnly(line: string, block: "setup" | "checks" = "checks"): boolean {
  if (!line.trim()) return false;
  if (DENY.some((r) => r.test(line))) return false;
  if (block === "checks" && INSTALL.test(line)) return false;
  return true;
}

const q = String.raw;

// Inline checkers: one line each, no file is added to the repo (the owner's rule for these PRs).
const PY_HTML = q`python3 -c 'import glob;exec("from html.parser import HTMLParser as P\nT=set(\"html head body div span section main header footer nav ul ol table a script style form button title\".split())\nclass H(P):\n def __init__(s):\n  super().__init__();s.k=[];s.e=[]\n def handle_starttag(s,t,a):\n  if t in T:s.k.append(t)\n def handle_endtag(s,t):\n  if t in T:\n   if s.k and s.k[-1]==t:s.k.pop()\n   else:s.e.append(t)\nbad=0\nfor f in glob.glob(\"**/*.html\",recursive=True):\n h=H();h.feed(open(f,encoding=\"utf-8\").read());h.close()\n if h.k or h.e:print(f,\"unbalanced\",h.k,h.e);bad=1\nraise SystemExit(bad)")'`;
const PY_JSON = q`python3 -c 'import glob,json;[json.load(open(f,encoding="utf-8")) for f in glob.glob("**/*.json",recursive=True) if "node_modules" not in f]'`;
const PY_ICS = q`python3 -c 'import glob;exec("bad=0\nfor f in glob.glob(\"**/*.ics\",recursive=True):\n t=open(f,encoding=\"utf-8\").read().strip()\n if not t.startswith(\"BEGIN:VCALENDAR\") or not t.endswith(\"END:VCALENDAR\") or t.count(\"BEGIN:VEVENT\")!=t.count(\"END:VEVENT\"):print(f,\"is not a valid calendar\");bad=1\nraise SystemExit(bad)")'`;
const PY_CSV = q`python3 -c 'import csv,glob;exec("bad=0\nfor f in glob.glob(\"**/*.csv\",recursive=True):\n r=list(csv.reader(open(f,newline=\"\",encoding=\"utf-8\")))\n if len({len(x) for x in r})>1:print(f,\"has rows of different length\");bad=1\nraise SystemExit(bad)")'`;
const PY_XML = q`python3 -c 'import glob,xml.dom.minidom as m;[m.parse(f) for f in glob.glob("**/*.xml",recursive=True) if "node_modules" not in f]'`;
const NODE_JSON = q`node -e 'const fs=require("fs");const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.name==="node_modules"||e.name===".git"?[]:e.isDirectory()?w(d+"/"+e.name):e.name.endsWith(".json")?[d+"/"+e.name]:[]);w(".").forEach(f=>JSON.parse(fs.readFileSync(f,"utf8")))'`;

const HAS_EXT = (paths: string[], ext: string): boolean =>
  paths.some((p) => p.endsWith(ext) && !p.split("/").includes("node_modules") && !p.startsWith(".git/"));

/** The folder the repo's tests live in, from its test globs and files: `tests`, or "" for none. */
function testDirOf(paths: string[], globs: string[]): { dir: string; files: string[] } | null {
  const isTest = picomatch(globs, { dot: true });
  const files = paths.filter((p) => isTest(p) && !p.split("/").includes("node_modules"));
  if (!files.length) return null;
  const top = files[0]!.includes("/") ? files[0]!.split("/")[0]! : "";
  const same = files.every((f) => (top ? f.startsWith(`${top}/`) : !f.includes("/")));
  return { dir: same ? top : "", files };
}

/** The default folder when the repo has none yet: the first plain directory in the test globs. */
function defaultTestDir(globs: string[]): string {
  for (const g of globs) {
    const m = /^([\w.-]+)\/\*\*/.exec(g);
    if (m) return m[1]!;
  }
  return "tests";
}

/** The test folder's line (REPO-34): run what is there, or a guarded line that passes while empty. */
function testLine(i: DraftInput): { line: string; from: string; guarded: boolean } | null {
  const globs = i.tests?.length ? i.tests : DEFAULT_TESTS;
  const found = testDirOf(i.paths, globs);
  const py = (fs: string[]) => fs.every((f) => f.endsWith(".py"));
  if (found) {
    const dir = found.dir || ".";
    if (py(found.files) && i.has.python3) {
      return {
        line: `python3 -m unittest discover -s ${dir}`,
        from: `the test files under ${dir}/`,
        guarded: false,
      };
    }
    if (i.has.node) {
      return {
        line: `node --test ${found.dir ? `${found.dir}/` : ""}`.trimEnd(),
        from: `the test files under ${dir}/`,
        guarded: false,
      };
    }
    return null;
  }
  const dir = defaultTestDir(globs);
  if (i.has.node) {
    return {
      line: `[ ! -d ${dir} ] || node --test ${dir}/`,
      from: `the test folder (${dir}/), which a later change can add`,
      guarded: true,
    };
  }
  if (i.has.python3) {
    return {
      line: `[ ! -d ${dir} ] || python3 -m unittest discover -s ${dir}`,
      from: `the test folder (${dir}/), which a later change can add`,
      guarded: true,
    };
  }
  return null;
}

const NO_TEST_SCRIPT = /no test specified/i;
const RUNS_TESTS = /\b(test|tests|pytest|unittest|vitest|jest|mocha)\b/i;

function finish(
  i: DraftInput,
  source: string,
  setup: Evidence[],
  checks: Evidence[],
  notCovered: string[],
  plainFiles = false,
): Draft | null {
  const safeSetup = setup.filter((e) => commandIsCheckOnly(e.line, "setup"));
  const safe = checks.filter((e) => commandIsCheckOnly(e.line, "checks"));
  if (!safe.length) return null;
  const all = [...safe];
  // A repo's own tool (npm, make, cargo) runs the tests it has; a repo of plain files needs the line to
  // run them. With no test folder yet, the guarded line is added in both cases, so a new test runs.
  const hasTests = testDirOf(i.paths, i.tests?.length ? i.tests : DEFAULT_TESTS) !== null;
  const covered = safe.some((e) => RUNS_TESTS.test(e.line)) || (hasTests && !plainFiles);
  let test = null as ReturnType<typeof testLine>;
  if (!covered) test = testLine(i);
  if (test) all.push({ line: test.line, from: test.from });
  return {
    source,
    setup: safeSetup.map((e) => e.line),
    checks: all.map((e) => e.line),
    evidence: [...safeSetup, ...all],
    notCovered,
    substantive: safe.map((e) => e.line),
  };
}

function packageManager(paths: string[]): { setup: string; run: (s: string) => string; lock: string } {
  const has = (f: string) => paths.includes(f);
  if (has("pnpm-lock.yaml"))
    return { setup: "pnpm install --frozen-lockfile", run: (s) => `pnpm run ${s}`, lock: "pnpm-lock.yaml" };
  if (has("yarn.lock"))
    return { setup: "yarn install --frozen-lockfile", run: (s) => `yarn run ${s}`, lock: "yarn.lock" };
  if (has("bun.lockb") || has("bun.lock"))
    return { setup: "bun install --frozen-lockfile", run: (s) => `bun run ${s}`, lock: "bun.lock" };
  if (has("package-lock.json"))
    return { setup: "npm ci", run: (s) => `npm run ${s}`, lock: "package-lock.json" };
  return { setup: "npm install", run: (s) => `npm run ${s}`, lock: "package.json" };
}

function fromPackage(i: DraftInput): Draft | null {
  const text = i.texts["package.json"];
  if (text === undefined) return null;
  let scripts: Record<string, string> = {};
  try {
    const s = (JSON.parse(text) as { scripts?: unknown }).scripts;
    if (s && typeof s === "object") scripts = s as Record<string, string>;
  } catch {
    return null;
  }
  const pm = packageManager(i.paths);
  const ok = (n: string) =>
    typeof scripts[n] === "string" &&
    !NO_TEST_SCRIPT.test(scripts[n]!) &&
    commandIsCheckOnly(scripts[n]!, "checks");
  const names = ok("check") ? ["check"] : ["lint", "typecheck", "test", "build"].filter(ok);
  if (!names.length) return null;
  const checks = names.map((n) => ({
    line: n === "test" && pm.run("test") === "npm run test" ? "npm test" : pm.run(n),
    from: `the "${n}" script in package.json`,
  }));
  const dev = Object.keys(scripts).length > 0;
  return finish(i, "package.json scripts", dev ? [{ line: pm.setup, from: pm.lock }] : [], checks, [
    "Anything the package's scripts don't run.",
  ]);
}

function fromMakefile(i: DraftInput): Draft | null {
  const text = i.texts.Makefile ?? i.texts.makefile ?? i.texts.GNUmakefile;
  if (text === undefined) return null;
  const has = (t: string) => new RegExp(`^${t}\\s*:`, "m").test(text);
  const target = has("check") ? "check" : has("test") ? "test" : null;
  if (!target) return null;
  return finish(
    i,
    "Makefile",
    [],
    [{ line: `make ${target}`, from: `the "${target}" target in the Makefile` }],
    ["Anything the Makefile target doesn't run."],
  );
}

/** The `run:` commands of workflows that run on pull requests. */
function workflowRuns(text: string): string[] {
  if (!/^\s*(on:|"on":)?.*\bpull_request\b/m.test(text)) return [];
  const out: string[] = [];
  const ls = text.split("\n");
  for (let n = 0; n < ls.length; n++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(ls[n]!);
    if (!m) continue;
    const rest = m[2]!.trim();
    if (rest && !/^[|>][+-]?$/.test(rest)) {
      out.push(rest.replace(/^["']|["']$/g, ""));
      continue;
    }
    const indent = m[1]!.length;
    for (let k = n + 1; k < ls.length; k++) {
      const l = ls[k]!;
      if (l.trim() && l.length - l.trimStart().length <= indent) break;
      if (l.trim()) out.push(l.trim());
    }
  }
  return out.filter((l) => !l.startsWith("#"));
}

function fromWorkflows(i: DraftInput): Draft | null {
  const setup: Evidence[] = [];
  const checks: Evidence[] = [];
  let skipped = false;
  for (const p of i.paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort()) {
    const text = i.texts[p];
    if (text === undefined) continue;
    for (const line of workflowRuns(text)) {
      const from = `${p}`;
      if (INSTALL.test(line)) {
        if (commandIsCheckOnly(line, "setup") && !setup.some((e) => e.line === line))
          setup.push({ line, from });
      } else if (commandIsCheckOnly(line, "checks")) {
        if (!checks.some((e) => e.line === line)) checks.push({ line, from });
      } else skipped = true;
    }
  }
  if (!checks.length) return null;
  return finish(i, "the CI workflows", setup, checks, [
    "Anything CI does only on a push, a release or with secrets.",
    ...(skipped ? ["CI steps that deploy, publish or use the network were left out."] : []),
  ]);
}

function fromManifest(i: DraftInput): Draft | null {
  if (i.paths.includes("Cargo.toml")) {
    return finish(
      i,
      "Cargo.toml",
      [{ line: "cargo fetch", from: "Cargo.toml" }],
      [{ line: "cargo test", from: "Cargo.toml" }],
      ["Lints and formatting."],
    );
  }
  if (i.paths.includes("go.mod")) {
    return finish(
      i,
      "go.mod",
      [{ line: "go mod download", from: "go.mod" }],
      [{ line: "go test ./...", from: "go.mod" }],
      ["Lints and formatting."],
    );
  }
  if (i.paths.includes("pyproject.toml")) {
    return finish(
      i,
      "pyproject.toml",
      [{ line: "pip install -e .", from: "pyproject.toml" }],
      [{ line: "python3 -m pytest", from: "pyproject.toml" }],
      ["Lints and formatting."],
    );
  }
  return null;
}

/** A repo of plain files: parse the HTML and validate the data files, with inline commands only. */
function fromStatic(i: DraftInput): Draft | null {
  // A repo with its own build tool has real checks; a failing one is reported, not swapped for a file parse.
  const built = [
    "package.json",
    "Makefile",
    "makefile",
    "GNUmakefile",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
  ];
  if (i.paths.some((p) => built.includes(p))) return null;
  const html = HAS_EXT(i.paths, ".html");
  const kinds = [".json", ".ics", ".csv", ".xml"].filter((e) => HAS_EXT(i.paths, e));
  if (!html && !kinds.length) return null;
  const checks: Evidence[] = [];
  const left: string[] = [];
  const py = i.has.python3;
  if (html) {
    if (py) checks.push({ line: PY_HTML, from: "the .html files" });
    else left.push("HTML pages (no Python in the sandbox to parse them).");
  }
  for (const k of kinds) {
    const from = `the ${k} files`;
    if (k === ".json" && py) checks.push({ line: PY_JSON, from });
    else if (k === ".json" && i.has.node) checks.push({ line: NODE_JSON, from });
    else if (k === ".ics" && py) checks.push({ line: PY_ICS, from });
    else if (k === ".csv" && py) checks.push({ line: PY_CSV, from });
    else if (k === ".xml" && py) checks.push({ line: PY_XML, from });
    else left.push(`${k} files (no checker available in the sandbox).`);
  }
  for (const k of [".yml", ".yaml", ".toml"]) {
    if (HAS_EXT(i.paths, k)) left.push(`${k} files (no inline checker).`);
  }
  if (!checks.length) return null;
  return finish(
    i,
    "the repo's plain files",
    [],
    checks,
    [...left, "Whether the page looks or works right: these checks parse files, they do not run them."],
    true,
  );
}

/** REPO-34: the drafts for a repo with no checks block, best source first (at most `MAX_DRAFTS`). */
export function draftVerifying(i: DraftInput): Draft[] {
  const out = [fromPackage, fromMakefile, fromWorkflows, fromManifest, fromStatic]
    .map((f) => f(i))
    .filter((d): d is Draft => d !== null && checksSomething(d));
  return out.slice(0, MAX_DRAFTS);
}

/** REPO-35: a draft needs at least one command that reads the repo's own files. */
export function checksSomething(d: Draft): boolean {
  return d.substantive.length > 0;
}

/** The file paths `draftVerifying` wants the text of. */
export function wanted(paths: string[]): string[] {
  const names = ["package.json", "Makefile", "makefile", "GNUmakefile", "TOWERCAB.md"];
  return paths.filter((p) => names.includes(p) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
}

const fence = (name: string, lines: string[]): string => `\`\`\`${name}\n${lines.join("\n")}\n\`\`\``;

/** The section to write: the heading and the blocks. */
export function verifyingSection(d: Draft): string {
  const blocks = [];
  if (d.setup.length) blocks.push(fence("setup", d.setup));
  blocks.push(fence("checks", d.checks));
  return `## Verifying your work\n\n${blocks.join("\n\n")}\n`;
}

/**
 * `CLAUDE.md` with the section added (REPO-36): created when there is none, the blocks put under an
 * existing heading, or the section appended. The text already there stays byte-identical.
 */
export function insertVerifying(claude: string | null, d: Draft, repoName: string): string {
  if (claude === null) return `# ${repoName}\n\n${verifyingSection(d)}`;
  const blocks = verifyingSection(d).replace(/^## Verifying your work\n\n/, "");
  const m = /^## Verifying your work[^\n]*\n/im.exec(claude);
  if (m) {
    const at = m.index + m[0].length;
    return `${claude.slice(0, at)}\n${blocks}${claude.slice(at)}`;
  }
  const sep = claude.endsWith("\n\n") ? "" : claude.endsWith("\n") ? "\n" : "\n\n";
  return `${claude}${sep}${verifyingSection(d)}`;
}

/** The PR's description, to `prompts/writing.md`: what, why, what to check, the changes. */
export function draftPrBody(d: Draft, o: { base: string; created: boolean; output: string }): string {
  const lines = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const where = d.evidence.map(
    (e) => `- \`${e.line.length > 90 ? `${e.line.slice(0, 87)}…` : e.line}\`: from ${e.from}`,
  );
  return [
    "## What this does",
    "",
    `Adds a "Verifying your work" section to \`CLAUDE.md\` so Towercab knows how to test this repo. The checks passed once on \`${o.base}\` before this PR was opened. Intents waiting on this repo continue by themselves once it merges.`,
    "",
    "## Why",
    "",
    "The repo had no checks, so Towercab could not tell whether a change worked. Rather than ask for them, it worked them out from what the repo holds: " +
      `${d.source}.`,
    "",
    "## What to check before merging",
    "",
    "Whether these checks are enough for this repo. Every command only reads the repo's files: none deploys, publishes or uses the network or a secret.",
    "",
    "What they do not cover:",
    "",
    lines(d.notCovered),
    "",
    "## Changes",
    "",
    `- ${o.created ? "Creates" : "Changes"} only \`CLAUDE.md\`; no script or other file is added.`,
    "- Where each line came from:",
    "",
    where.join("\n"),
    "",
    `<details><summary>Output of the run on ${o.base}</summary>\n\n\`\`\`\n${o.output.trim().slice(-3000)}\n\`\`\`\n\n</details>`,
  ].join("\n");
}
