// Checks that must write to the repo cache (PIP-95): a read-only error under the cache is a question
// for the owner, not a repair; "Allow" is remembered for the repo and the checks run again writable,
// anything else waits `checks red`.

import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { allowsCacheWrite, readOnlyCachePath } from "../../src/pipeline/checks.ts";
import { happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const CLIPPY = "cargo clippy --all-targets --locked -- -D warnings";

/** Checks fail as cargo does when the cache is mounted read-only; with it writable they run. */
function readOnlyCache(p: Pipe): void {
  const cache = p.home.cache("web");
  p.sandbox = (spec) => {
    if (spec.kind !== "checks") return null;
    if (spec.argv[spec.argv.indexOf(cache) - 1] === "--bind") return null;
    writeFileSync(spec.stdout, `$ ${CLIPPY}\n`);
    writeFileSync(
      spec.stderr,
      `error: failed to open: ${cache}/target/debug/.cargo-build-lock\n\nCaused by:\n  Read-only file system (os error 30)\n`,
    );
    return { code: 101, signal: null };
  };
}

async function asked(): Promise<Pipe> {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  readOnlyCache(p);
  await p.start();
  await p.until(() => p.mission()?.waiting === "allow check writes");
  return p;
}

/** The owner answers on the intent's current PR (the merged plan PR). */
function answer(p: Pipe, text: string): void {
  p.ownerComment(p.prNo("intents", p.mission()!.plan_pr!), text);
}

const workers = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "worker");
const checksRuns = (p: Pipe) => p.sandboxRuns.filter((r) => r.kind === "checks");

let p: Pipe;

beforeAll(async () => {
  p = await asked();
}, 30_000);

afterAll(() => p.cleanup());

test("pipeline: a read-only cache write asks the owner", () => {
  const m = p.mission()!;
  const cache = p.home.cache("web");
  expect([m.stage, m.from_stage, m.waiting], p.moves()).toEqual(["blocked", "verify", "allow check writes"]);
  expect(m.why).toBe("May the checks of web write to its build cache?");
  // Not the code's fault: no repair round went to the worker.
  expect(workers(p)).toHaveLength(1);
  expect(m.repairs).toBe(0);
  const body = p
    .prNo("intents", m.plan_pr!)
    .comments.filter((c) => c.author === "towercab[bot]")
    .at(-1)!.body;
  expect(body).toContain(`\`${CLIPPY}\` tried to write \`${cache}/target/debug/.cargo-build-lock\``);
  expect(body).toContain("The code is not at fault");
  expect(body).toContain("- **Allow**: Towercab remembers this for web");
  expect(body).toContain('- **Don\'t allow**: The intent waits as "checks red"');
  expect(body).toContain("**Recommendation:** Allow.");
  const msg = p.db.get<{ text: string }>(
    "SELECT text FROM outbox WHERE key LIKE ?",
    `${m.id}:allow check writes:%`,
  );
  expect(msg?.text).toMatch(
    /^Decide if the tests may write to this machine's shared build cache: reply allow or no\.\n/,
  );
});

test("pipeline: allowing cache writes reruns the checks writable", async () => {
  const m = p.mission()!;
  answer(p, "Allow");
  await p.until(() => p.stages(m.id).includes("publish"));
  expect(p.stages(m.id), p.moves()).toContain("publish");
  expect(p.db.meta("checks-write:web")).toBe("1");
  // The answer is read at verify, not sent to the worker.
  expect(workers(p)).toHaveLength(1);
  const cache = p.home.cache("web");
  const last = checksRuns(p).at(-1)!;
  expect(last.argv[last.argv.indexOf(cache) - 1]).toBe("--bind");
  expect(p.mission(m.id)!.data).not.toContain("cacheAsk");
}, 30_000);

test("pipeline: refusing cache writes waits checks red", async () => {
  const q = await asked();
  try {
    answer(q, "Don't allow");
    await q.until(() => q.mission()?.waiting === "checks red");
    const m = q.mission()!;
    expect([m.stage, m.waiting], q.moves()).toEqual(["blocked", "checks red"]);
    expect(m.why).toMatch(
      /^You didn't allow the checks of web to write to its build cache, so they can't run\. Make them write inside the checkout/,
    );
    expect(q.db.meta("checks-write:web")).toBeNull();
    expect(workers(q)).toHaveLength(1);
  } finally {
    q.cleanup();
  }
}, 30_000);

test("checks: read-only cache path", () => {
  const cache = "/h/cache/web";
  const cargo = `$ ${CLIPPY}\nerror: failed to open: ${cache}/target/debug/.cargo-build-lock\n\nCaused by:\n  Read-only file system (os error 30)\n`;
  expect(readOnlyCachePath(cargo, cache)).toEqual({
    path: `${cache}/target/debug/.cargo-build-lock`,
    command: CLIPPY,
  });
  const python = `$ pytest\nOSError: [Errno 30] Read-only file system: '${cache}/pip/x.whl'\n`;
  expect(readOnlyCachePath(python, `${cache}/`)).toEqual({ path: `${cache}/pip/x.whl`, command: "pytest" });
  const node = `EROFS: read-only file system, open '${cache}/npm/_cacache/tmp'`;
  expect(readOnlyCachePath(node, cache)).toEqual({ path: `${cache}/npm/_cacache/tmp`, command: null });
  // A read-only path outside the cache, another repo's cache, or no read-only error: not this case.
  expect(readOnlyCachePath("touch: cannot touch '/usr/x': Read-only file system", cache)).toBeNull();
  expect(readOnlyCachePath(`'${cache}-2/x': Read-only file system`, cache)).toBeNull();
  expect(readOnlyCachePath(`error: ${cache}/target missing\nassertion failed`, cache)).toBeNull();
  // The answer: allow, yes or ok at the start allows.
  for (const a of ["Allow", "allow it", "Yes", "ok"]) expect(allowsCacheWrite(a)).toBe(true);
  for (const a of ["Don't allow", "no", "", undefined, "allowance? no"])
    expect(allowsCacheWrite(a)).toBe(false);
});
