// Access (PIP-47, AUT-14, AUT-15): the plan's Access checklist, written and read back, and the
// grants a worker run gets at its effective autonomy.

import { accessPolicy } from "../autonomy.ts";
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

/**
 * PIP-116: whether the owner's reply allows the change: it starts with a clear yes and says nothing
 * against it. Anything else, or no reply, refuses.
 */
export function readsAsAllow(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (!/^(allow|yes|ok|okay|approve|approved|go ahead)\b/.test(t)) return false;
  return !/\b(not|no|don't|dont|never|refuse|keep|without)\b/.test(t);
}

/** A test the worker asked to change, with the reason. */
export interface TestAsk {
  path: string;
  why: string;
  /** Asked for in the same round; they are put to the owner one after the other. */
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

/** PIP-116: the question naming the test and why, with the two answers (PIP-110). */
export function testQuestion(t: { path: string; why: string }): Question {
  return {
    context: `The worker needs to change the existing test \`${t.path}\`, which the approved plan did not list. Its reason: ${oneLine(t.why) || "none given"}.`,
    question: `May the worker change \`${t.path}\`?`,
    options: [
      {
        option: "Allow this change",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "The worker may edit this one test file and carries on; the code PR and the intent page list it.",
      },
      {
        option: "Keep the test as it is",
        // biome-ignore lint/suspicious/noThenProperty: the question schema's key; never awaited.
        then: "The file stays locked for the rest of the build; the worker has to make the change fit the test.",
      },
    ],
    recommendation:
      "Keep the test unless the reason shows the old test is out of date; a change that only passes by editing its own test proves little.",
  };
}

/**
 * PIP-116: the owner's reply to the test asked about → the data patch: allowed joins the grants,
 * anything else is refused for good; plus the note the resumed worker is told.
 */
export function answerTest(
  ask: TestAsk,
  d: TestState,
  reply: string | null | undefined,
): {
  patch: { testAllowed?: { path: string; why: string }[]; refusedTests?: { path: string; why: string }[] };
  note: string;
} {
  const t = { path: ask.path, why: ask.why };
  if (readsAsAllow(reply)) {
    return {
      patch: { testAllowed: [...(d.testAllowed ?? []), t] },
      note: `The owner allowed you to change ${t.path}.`,
    };
  }
  return {
    patch: { refusedTests: [...(d.refusedTests ?? []), t] },
    note: `The owner refused changes to ${t.path}: it stays as it is. Finish without changing it; if that is impossible, return status blocked and explain.`,
  };
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
