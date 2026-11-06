// Access (PIP-47, AUT-14, AUT-15): the plan's Access checklist, written and read back, and the
// grants a worker run gets at its effective autonomy.

import { accessPolicy } from "../autonomy.ts";
import { stripAgentHeader } from "../github/agent-header.ts";
import type { Access, Question } from "./schemas.ts";

/** What a worker run may reach: domains for the sandbox and WebFetch, writable protected globs, open network. */
export interface Grants {
  domains: string[];
  paths: string[];
  open: boolean;
}

/** What the level grants without asking, in one sentence for the owner (AUT-14, AUT-18). */
export function levelSentence(a: number): string {
  if (a <= 3) {
    return `At a${a} you merge the code PR yourself, so the worker can reach the default package registries and docs plus the boxes ticked here, may change protected files (the PR lists them), and gets anything else it asks for while building.`;
  }
  if (a === 4) {
    return "At a4 the worker can reach the default package registries and docs plus the boxes ticked here, and may change only the protected paths ticked here; if it needs more while building, it gets it, but you merge the code PR. Otherwise Towercab merges the code PR itself when its risk is low.";
  }
  return "At a5 the worker has open network and may change protected files, and Towercab merges the code PR once every check passes, unless its risk is high.";
}

/**
 * The plan's `## Access` section: the level's sentence, then one ticked line per domain, path and
 * existing test (PIP-115). `dropped` = test paths the plan named that need no grant, said in a sentence.
 */
export function renderAccess(access: Access, a: number, dropped: string[] = []): string {
  const out = ["## Access", "", levelSentence(a), ""];
  const why = (w: string) => (w.trim() ? ` (${oneLine(w)})` : "");
  for (const d of access.domains) out.push(`- [x] network: ${d.domain}${why(d.why)}`);
  for (const p of access.paths) out.push(`- [x] path: ${p.glob}${why(p.why)}`);
  for (const t of access.tests) out.push(`- [x] test: ${t.path}${why(t.why)}`);
  if (!access.domains.length && !access.paths.length && !access.tests.length)
    out.push("Nothing beyond what the level grants.");
  if (access.tests.length) {
    out.push(
      "",
      "Existing tests are read-only for the worker; merging this plan lets it change only the ticked tests above.",
    );
  }
  if (dropped.length) {
    out.push(
      "",
      `Not listed as grants, since they are not existing test files and need none: ${dropped.join(", ")}.`,
    );
  }
  return `${out.join("\n")}\n`;
}

const LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(network|path|test):\s+(\S+)(?:\s+\((.*)\))?\s*$/;

/**
 * The ticked lines of a merged `plan.md`'s `## Access` section; unticked ones aren't granted, and
 * no section grants nothing beyond the defaults.
 */
export function parseAccess(planMd: string): Access {
  const access: Access = { domains: [], paths: [], tests: [] };
  let inside = false;
  let fence = false;
  for (const line of planMd.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    if (/^#{1,2} /.test(line)) {
      inside = /^## +Access\s*$/i.test(line);
      continue;
    }
    if (!inside) continue;
    const m = LINE.exec(line);
    if (!m || m[1] === " ") continue;
    const why = m[4] ?? "";
    if (m[2] === "network") access.domains.push({ domain: m[3]!, why });
    else if (m[2] === "test") access.tests.push({ path: m[3]!, why });
    else access.paths.push({ glob: m[3]!, why });
  }
  return access;
}

/** An existing test a worker may change, and who allowed it (PIP-115, PIP-116). */
export interface TestGrant {
  path: string;
  why: string;
  by: "plan" | "owner";
}

/** The mission data the test grants come from. */
export interface TestState {
  granted?: { tests?: { path: string; why: string }[] };
  testAllowed?: { path: string; why: string }[];
  refusedTests?: { path: string; why: string }[];
  /** PIP-152: tests the last run was blocked from; the owner may allow them. */
  lockedTests?: string[];
}

/** The existing tests granted by the merged plan and by the owner's answers; a path once. */
export function testGrantsOf(d: TestState): TestGrant[] {
  const out: TestGrant[] = [];
  for (const t of d.granted?.tests ?? []) out.push({ ...t, by: "plan" });
  for (const t of d.testAllowed ?? []) {
    if (!out.some((o) => o.path === t.path)) out.push({ ...t, by: "owner" });
  }
  return out;
}

/** REPO-13: the existing tests still blocked: those on the base branch that no grant covers. */
export function blockedTests(existing: string[], d: TestState): string[] {
  const granted = new Set(testGrantsOf(d).map((g) => g.path));
  return existing.filter((p) => !granted.has(p));
}

// The first whole word of a reply decides (PIP-138): `no,` is `no`, `not` and `nothing` are not.
const ALLOW_WORD = /^(yes|allow|ok|okay|approve|approved|go ahead)(?![\w'’])/i;
const REFUSE_WORD = /^(no|refuse|don['’]?t|keep)(?![\w'’])/i;
const NOT_LETTERS = /^[^\p{L}\p{N}]+/u;

/** What a reply decided about the files asked (PIP-138, PIP-139). */
export interface Reading {
  allowed: string[];
  refused: string[];
  /** Asked, and not decided by the reply: they stay asked. */
  undecided: string[];
  /** On an allow: what follows the allow word, for the worker; "" for a bare allow. */
  conditions: string;
}

/**
 * PIP-138, PIP-139: reads the owner's reply by its first whole word. An allow word allows, a refusal
 * word refuses, anything else (or no reply) decides nothing. A reply that names some of the asked
 * paths decides those; one that names none decides them all. Later words never change the reading.
 */
export function readReply(text: string | null | undefined, asked: string[]): Reading {
  const raw = stripAgentHeader(text ?? "").trim();
  const body = raw.replace(NOT_LETTERS, "");
  const allow = ALLOW_WORD.test(body);
  if (!allow && !REFUSE_WORD.test(body)) {
    return { allowed: [], refused: [], undecided: [...asked], conditions: "" };
  }
  const named = asked.filter((p) => raw.includes(p));
  const decided = named.length ? named : [...asked];
  const undecided = asked.filter((p) => !decided.includes(p));
  if (!allow) return { allowed: [], refused: decided, undecided, conditions: "" };
  const rest = body
    .replace(ALLOW_WORD, "")
    .replace(/^[\s,.:;!\-–—]+/, "")
    .trim();
  const bare = /^(this change|this|it|them|all( of them)?|please)?[\s.!]*$/i.test(rest);
  return { allowed: decided, refused: [], undecided, conditions: bare ? "" : rest };
}

const fileList = (label: string, paths: string[]) =>
  paths.length > 3
    ? `${label}:\n${paths.map((p) => `- \`${p}\``).join("\n")}`
    : `${label}: ${paths.map((p) => `\`${p}\``).join(", ")}`;

/** PIP-140: what Towercab says it understood: allowed, refused and still-asked files. */
export function readingReply(r: Pick<Reading, "allowed" | "refused" | "undecided">): string {
  const out: string[] = [];
  if (r.allowed.length) out.push(fileList("Allowed", r.allowed));
  if (r.refused.length) out.push(fileList("Refused", r.refused));
  if (r.undecided.length) out.push(fileList("Still asked", r.undecided));
  if (r.undecided.length) {
    out.push("I could not tell whether this is a yes or a no. Reply starting with yes or no.");
  }
  if (r.refused.length) out.push("Reply `allow <path>` to change a refusal.");
  return out.join("\n\n");
}

/** PIP-141: `allow <path> …` (every word a file path) → the paths; else null. */
export function parseAllow(text: string | null | undefined): string[] | null {
  const m = /^\s*allow\s+(.+)$/is.exec(stripAgentHeader(text ?? ""));
  if (!m) return null;
  const tokens = m[1]!
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^`|`$/g, ""));
  const pathLike = (t: string) => /^[\w@.\-/]+$/.test(t) && (t.includes("/") || /\.\w+$/.test(t));
  return tokens.length && tokens.every(pathLike) ? tokens : null;
}

/**
 * PIP-141: moves refused tests to the owner's grants. Throws unless every path was refused, listing
 * the refused ones. The patch also tells the worker its next round.
 */
export function reverseRefusals(
  d: TestState & { testNote?: string },
  paths: string[],
): {
  patch: {
    testAllowed: { path: string; why: string }[];
    refusedTests: { path: string; why: string }[] | undefined;
    lockedTests: string[] | undefined;
    testNote: string;
  };
  moved: string[];
} {
  const refused = d.refusedTests ?? [];
  const locked = d.lockedTests ?? [];
  const bad = paths.filter((p) => !refused.some((r) => r.path === p) && !locked.includes(p));
  if (bad.length) {
    throw new Error(
      `${bad.join(", ")} ${bad.length > 1 ? "were" : "was"} not refused; ${
        refused.length ? `refused: ${refused.map((r) => r.path).join(", ")}` : "no test is refused"
      }${locked.length ? `; locked: ${locked.join(", ")}` : ""}`,
    );
  }
  const movedRefused = refused.filter((r) => paths.includes(r.path));
  // PIP-152: a path the repair lock stopped is allowed like a refused one.
  const movedLocked = paths
    .filter((p) => !movedRefused.some((r) => r.path === p))
    .map((path) => ({ path, why: "the owner allowed the locked test" }));
  const moved = [...movedRefused, ...movedLocked];
  const left = refused.filter((r) => !paths.includes(r.path));
  const stillLocked = locked.filter((p) => !paths.includes(p));
  const note = `The owner now allows you to change ${moved.map((r) => r.path).join(", ")}: ${
    movedRefused.length ? "the earlier refusal is lifted" : "it is no longer locked"
  }.`;
  return {
    moved: moved.map((r) => r.path),
    patch: {
      testAllowed: [
        ...(d.testAllowed ?? []),
        ...moved.filter((r) => !(d.testAllowed ?? []).some((a) => a.path === r.path)),
      ],
      refusedTests: left.length ? left : undefined,
      lockedTests: stillLocked.length ? stillLocked : undefined,
      testNote: [d.testNote, note].filter(Boolean).join(" "),
    },
  };
}

/** A test the worker asked to change, with the reason. */
export interface TestAsk {
  path: string;
  why: string;
  /** Asked for in the same round; they are in the same question (PIP-136). */
  rest: { path: string; why: string }[];
}

/** PIP-116: what to do with the tests a worker asked for. */
export function sortTestRequests(
  asked: { path: string; why: string }[],
  d: TestState,
  existing: string[],
): {
  ask: { path: string; why: string }[];
  refused: string[];
  granted: string[];
  notBlocked: string[];
} {
  const out = {
    ask: [] as { path: string; why: string }[],
    refused: [] as string[],
    granted: [] as string[],
    notBlocked: [] as string[],
  };
  const grants = new Set(testGrantsOf(d).map((g) => g.path));
  const refused = new Set((d.refusedTests ?? []).map((t) => t.path));
  for (const t of asked) {
    if (out.ask.some((x) => x.path === t.path)) continue;
    if (grants.has(t.path)) out.granted.push(t.path);
    else if (refused.has(t.path)) out.refused.push(t.path);
    else if (!existing.includes(t.path)) out.notBlocked.push(t.path);
    else out.ask.push(t);
  }
  return out;
}

/** PIP-136: the tests a `TestAsk` still asks about, the first and the rest. */
export function askedTests(ask: TestAsk): { path: string; why: string }[] {
  return [{ path: ask.path, why: ask.why }, ...ask.rest];
}

/**
 * PIP-116, PIP-136: the question naming the test and why, with the two answers (PIP-110); several tests
 * are one question listing each with its reason.
 */
export function testQuestion(
  tests: { path: string; why: string } | { path: string; why: string }[],
): Question {
  const list = Array.isArray(tests) ? tests : [tests];
  const t = list[0]!;
  if (list.length > 1) {
    return {
      context: `The worker needs to change ${list.length} existing tests, which the approved plan did not list:\n${list
        .map((x) => `- \`${x.path}\`: ${oneLine(x.why) || "no reason given"}`)
        .join("\n")}`,
      question: `May the worker change these ${list.length} tests?`,
      options: [
        {
          option: "Allow all of them",
          do: "continue",
          // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
          then: "The worker may edit these test files and carries on; the code PR and the intent page list them.",
        },
        {
          option: "No, keep all as they are",
          do: "continue",
          // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
          then: "The files stay locked for the rest of the build; the worker has to make the change fit the tests. To allow only some, reply with yes and the paths.",
        },
      ],
      recommendation:
        "Keep a test unless its reason shows the old test is out of date; a change that only passes by editing its own test proves little. Helper files that only grow are the easy ones to allow.",
    };
  }
  return {
    context: `The worker needs to change the existing test \`${t.path}\`, which the approved plan did not list. Its reason: ${oneLine(t.why) || "none given"}.`,
    question: `May the worker change \`${t.path}\`?`,
    options: [
      {
        option: "Allow this change",
        do: "continue",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "The worker may edit this one test file and carries on; the code PR and the intent page list it.",
      },
      {
        option: "No, keep the test as it is",
        do: "continue",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "The file stays locked for the rest of the build; the worker has to make the change fit the test.",
      },
    ],
    recommendation:
      "Keep the test unless the reason shows the old test is out of date; a change that only passes by editing its own test proves little.",
  };
}

/**
 * PIP-116, PIP-138, PIP-139: the owner's reply to the test asked about → the data patch: a yes joins
 * the grants (with its conditions in the note the resumed worker is told), a no is refused for good,
 * and a reply that is neither decides nothing (`read.undecided`): the test is asked again.
 */
export function answerTest(
  ask: TestAsk,
  d: TestState,
  reply: string | null | undefined,
): {
  patch: { testAllowed?: { path: string; why: string }[]; refusedTests?: { path: string; why: string }[] };
  note: string;
  read: Reading;
} {
  const all = askedTests(ask);
  const read = readReply(
    reply,
    all.map((t) => t.path),
  );
  const allowed = all.filter((t) => read.allowed.includes(t.path));
  const refused = all.filter((t) => read.refused.includes(t.path));
  const patch: {
    testAllowed?: { path: string; why: string }[];
    refusedTests?: { path: string; why: string }[];
  } = {};
  const notes: string[] = [];
  if (allowed.length) {
    const on = read.conditions
      ? `, on these conditions: ${oneLine(read.conditions)}. Their reply: "${oneLine(reply ?? "")}"`
      : ".";
    patch.testAllowed = [...(d.testAllowed ?? []), ...allowed];
    notes.push(`The owner allowed you to change ${allowed.map((t) => t.path).join(", ")}${on}`);
  }
  if (refused.length) {
    patch.refusedTests = [...(d.refusedTests ?? []), ...refused];
    notes.push(
      `The owner refused changes to ${refused.map((t) => t.path).join(", ")}: ${refused.length > 1 ? "they stay" : "it stays"} as ${refused.length > 1 ? "they are" : "it is"}. Finish without changing ${refused.length > 1 ? "them" : "it"}; if that is impossible, return status blocked and explain.`,
    );
  }
  return { patch, note: notes.join(" "), read };
}

/** Inputs of `grantsFor`. */
export interface GrantInput {
  /** Effective `a` (`effectiveA`). */
  a: number;
  /** The intent's `source` (a5 needs `me`, AUT-13). */
  source: string | null;
  /** The merged plan's ticked access, or null before a plan. */
  plan: Access | null;
  /** The intent's own `unlock` and `network` fields. */
  unlock: string[];
  network: string[];
  /** `[agent].network`. */
  defaults: string[];
  /** Access granted mid-build (AUT-15, `data.unplanned`). */
  unplanned: Omit<Access, "tests"> | null;
}

/**
 * A worker run's grants (AUT-14): the default list, the plan's and the intent's domains and any
 * granted mid-build; protected paths: all (but `.git`) at a1–a3 and a5, else the plan's, the
 * intent's `unlock` and those granted mid-build; open network only at a5 for the owner's intents.
 */
export function grantsFor(g: GrantInput): Grants {
  const policy = accessPolicy(g.a);
  const domains = uniq([
    ...g.defaults,
    ...(g.plan?.domains.map((d) => d.domain) ?? []),
    ...g.network,
    ...(g.unplanned?.domains.map((d) => d.domain) ?? []),
  ]);
  const paths =
    policy.protectedPaths === "writable"
      ? ["**"]
      : uniq([
          ...(g.plan?.paths.map((p) => p.glob) ?? []),
          ...g.unlock,
          ...(g.unplanned?.paths.map((p) => p.glob) ?? []),
        ]);
  const own = g.source === null || g.source === "" || g.source === "me";
  return { domains, paths, open: policy.network === "open" && own };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
