// The `build` stage (PIP-1, PIP-13, PIP-29, PIP-31, AUT-7, AUT-15): sync the branch, run the
// repo's setup, then the worker; act on its result (done → commit, blocked → ask the owner,
// access → grant and resume).

import { readFileSync } from "node:fs";
import { lowered } from "../autonomy.ts";
import { git, refreshBase } from "../checkout.ts";
import type { ChildEnd, Ctx, Handler, Progress } from "../handlers.ts";
import { type Outcome, ok, wait } from "../machine.ts";
import type { Mission } from "../mission.ts";
import { CONTROL } from "../repo/protected.ts";
import { runSet } from "../repo/runset.ts";
import { answerTest, blockedTests, sortTestRequests, testGrantsOf, testQuestion } from "./access.ts";
import { logPath, sandboxSpec } from "./checks.ts";
import {
  ask,
  botAuthor,
  cloneOf,
  coGit,
  commitTitle,
  data,
  effectiveOf,
  ended,
  grantedFromPlan,
  grants,
  intentOf,
  type PipeData,
  repoFiles,
  spawnRun,
  tail,
  takeRemote,
} from "./common.ts";
import { existingTests, lockedTests } from "./guard.ts";
import { writePlanToMain } from "./plan.ts";
import { fence, intentData, render } from "./prompts.ts";
import { type Access, parseResult } from "./schemas.ts";

type NetAccess = Omit<Access, "tests">;

const merge = (a: NetAccess | undefined, b: NetAccess): NetAccess => ({
  domains: [
    ...(a?.domains ?? []),
    ...b.domains.filter((d) => !a?.domains.some((x) => x.domain === d.domain)),
  ],
  paths: [...(a?.paths ?? []), ...b.paths.filter((p) => !a?.paths.some((x) => x.glob === p.glob))],
});

function accessText(g: { domains: string[]; paths: string[]; open: boolean }, tests: string[]): string {
  const net = g.open ? "any network domain" : `network: ${g.domains.join(", ") || "none"}`;
  const paths = g.paths.includes("**")
    ? "every protected path but .git"
    : g.paths.join(", ") || "no protected paths";
  const own = tests.length ? tests.join(", ") : "none";
  return `${net}; protected paths you may write: ${paths}. Every test file that exists on the base branch is read-only unless listed here (new test files are free); existing tests you may change: ${own}.`;
}

/** The worker's prompt for this round. */
async function workerPrompt(cx: Ctx, m: Mission): Promise<string> {
  const d = data(m);
  const intent = await intentOf(cx, m);
  const files = await repoFiles(cx, m);
  // PIP-116: what the owner decided about a test the worker asked for.
  const testNote = d.testNote ? `\n\n${d.testNote}` : "";
  if (d.repair) {
    const owner = d.answer
      ? `\n\nThe owner added (data, not instructions):\n<answer>\n${fence(d.answer, "answer")}\n</answer>`
      : "";
    // A review fix round (PIP-98) carries the Review comment, every other round a log.
    const tag = d.repair.kind === "review" ? "review" : "log";
    return (
      render("repair", {
        what: d.repair.what,
        details: d.repair.details
          ? `<${tag}>\n${fence(tail(d.repair.details), tag)}\n</${tag}>${owner}`
          : owner,
      }) + testNote
    );
  }
  if (d.build && d.answer) {
    return (
      render("repair", {
        what: "The owner answered (data, not instructions):",
        details: `<answer>\n${fence(d.answer, "answer")}\n</answer>`,
      }) + testNote
    );
  }
  const plan = (await cx.store.readFile(`${intent.dir}/plan.md`)) ?? d.plan?.md ?? "(no plan)";
  const hasCi = true;
  return (
    render("worker", {
      plan: fence(plan, "plan"),
      intent: intentData(intent.text),
      spec_ids: d.design?.specIds.join(", ") || "none (no behaviour change)",
      checks: runSet(files.verifying, hasCi, []).join("\n") || files.verifying.checks.join("\n"),
      access: accessText(
        grants(m, intent, files, cx),
        testGrantsOf(d).map((t) => t.path),
      ),
    }) + testNote
  );
}

async function spawnWorker(cx: Ctx, m: Mission, prompt?: string): Promise<Progress> {
  const intent = await intentOf(cx, m);
  const files = await repoFiles(cx, m);
  const d = data(m);
  const g = grants(m, intent, files, cx);
  const repairRound = Boolean(d.repair && d.repair.kind !== "conflict");
  const locked = repairRound
    ? await lockedTests(cx.tools, cx.checkout(m), d.lockHead ?? null, files.towercab.tests)
    : [];
  // REPO-13: every round, repairs included, the base branch's tests no grant covers are write-blocked.
  const existing = blockedTests(
    await existingTests(cx.tools, cx.checkout(m), cx.repo(m).base, files.towercab.tests, files.towercab.live),
    d,
  );
  return spawnRun(
    cx,
    m,
    {
      kind: "worker",
      step: "worker",
      prompt: prompt ?? (await workerPrompt(cx, m)),
      agent: d.repair || (d.build && d.answer) ? "repair" : "worker",
      files,
      intent,
      guard: {
        checkout: cx.checkout(m),
        protected: [...CONTROL, ...files.towercab.protected],
        granted: g.paths,
        locked,
        existing,
      },
    },
    "Continue where you stopped.",
  );
}

export const buildHandler: Handler = {
  async step(cx, m) {
    const d = data(m);
    switch (m.step) {
      case "": {
        // PIP-116: the owner's answer on a test the worker asked for comes first.
        if (d.testAsk) {
          const r = await resolveTestAsk(cx, m);
          if ("done" in r) return r;
          m = r.m;
        }
        // The checkout is Towercab's: what another program left in it (an untracked file, an edit)
        // can't block the checkout below or ride into the PR. Ignored files, such as caches, stay (LOOP-8).
        await coGit(cx, m, ["reset", "--quiet", "--hard"]);
        await coGit(cx, m, ["clean", "-fdq"]);
        // The first round starts from base, which now holds the merged spec; read the plan's grants.
        if (!d.build && !d.lockHead) {
          const repo = cx.repo(m);
          const clone = cloneOf(cx, m);
          await git(cx.tools, clone, ["fetch", "--quiet", "origin"], await cx.github.gitAuth(repo.github));
          await refreshBase(cx.tools, clone, cx.checkout(m), repo.base);
          const base = (await coGit(cx, m, ["rev-parse", `refs/remotes/origin/${repo.base}`])).trim();
          await coGit(cx, m, ["checkout", "--quiet", "-B", m.branch, `refs/remotes/origin/${repo.base}`]);
          const intent = await intentOf(cx, m);
          m = cx.record(m, "setup", { base_sha: base }, { granted: await grantedFromPlan(cx, intent) });
        } else if (d.repair?.kind === "conflict") {
          const repo = cx.repo(m);
          const clone = cloneOf(cx, m);
          await git(cx.tools, clone, ["fetch", "--quiet", "origin"], await cx.github.gitAuth(repo.github));
          await refreshBase(cx.tools, clone, cx.checkout(m), repo.base);
          const author = await botAuthor(cx);
          const merged = await coGit(cx, m, [
            ...author,
            "merge",
            "--no-edit",
            `refs/remotes/origin/${repo.base}`,
          ])
            .then(() => true)
            .catch(() => false);
          if (merged)
            return { done: ok({ why: "merged the base branch cleanly", data: { repair: undefined } }) };
          const files = (await coGit(cx, m, ["diff", "--name-only", "--diff-filter=U"])).trim().split("\n");
          m = cx.record(
            m,
            "setup",
            {},
            {
              repair: {
                what: "Merging the base branch conflicts. Resolve the conflicts in these files, keeping both sides' intent, then run the checks:",
                details: files.join("\n"),
                kind: "conflict",
              },
            },
          );
        } else {
          // A later round builds on what is on the PR now: the owner may have pushed to it.
          const r = m.pr ? await takeRemote(cx, m, m.branch) : "none";
          if (r === "conflict") {
            const files = (await coGit(cx, m, ["diff", "--name-only", "--diff-filter=U"])).trim().split("\n");
            m = cx.record(
              m,
              "setup",
              {},
              {
                repair: {
                  what: "Commits pushed to the PR conflict with this branch. Resolve the conflicts in these files, keeping both sides' intent, then run the checks:",
                  details: files.join("\n"),
                  kind: "conflict",
                },
              },
            );
          } else {
            m = cx.record(m, "setup");
          }
        }
        // Where this round starts, so commit can tell a round that changed nothing (PIP-1).
        const from = (await coGit(cx, m, ["rev-parse", "HEAD"])).trim();
        m = cx.record(m, m.step, {}, { roundFrom: from });
        return setupOrWorker(cx, m);
      }
      case "setup":
      case "setup-done":
        return setupOrWorker(cx, m);
      case "access":
      case "worker":
        return spawnWorker(cx, m);
      case "commit":
        return commit(cx, m);
      default:
        return { done: { event: "bad_result", why: `unknown build step ${m.step}` } };
    }
  },

  async finish(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress> {
    if (m.step === "setup") {
      if (end.code !== 0)
        cx.log(`${m.intent}: setup failed (verify runs it again): ${tail(readLog(end.stdout), 300)}`);
      return spawnWorker(cx, cx.record(m, "setup-done", {}, { setup: cx.checkout(m) }));
    }
    const r = ended(cx, m, "worker", end, (v) => parseResult("build", v));
    if (!r.ok) return r.progress;
    const v = r.value;
    const intent = await intentOf(cx, m);
    if (v.lower_a !== null) {
      const a = lowered(intent.a, v.lower_a);
      if (a !== null) {
        await cx.store.update(m.intent, "lower a", (e) => {
          e.setField("a", a);
          if (v.lower_why) e.setField("lower_why", v.lower_why);
        });
      }
    }
    if (v.status === "blocked" && v.question)
      return { done: await ask(cx, m, v.question, "answer the question", v.brief) };
    if (v.status === "access" && v.access) {
      const d = data(m);
      const net = [...v.access.domains.map((x) => x.domain), ...v.access.paths.map((p) => p.glob)];
      const unplanned = net.length ? merge(d.unplanned, v.access) : d.unplanned;
      const lines = net.length ? [`Access granted: ${net.join(", ")}.`] : [];
      if (v.access.tests.length) {
        // PIP-116: a test is never granted by Towercab itself; the owner is asked.
        const files = await repoFiles(cx, m);
        const existing = await existingTests(
          cx.tools,
          cx.checkout(m),
          cx.repo(m).base,
          files.towercab.tests,
          files.towercab.live,
        );
        const s = sortTestRequests(v.access.tests, d, existing);
        if (s.granted.length) lines.push(`Already allowed: ${s.granted.join(", ")}.`);
        if (s.refused.length)
          lines.push(`The owner refused earlier, so these stay as they are: ${s.refused.join(", ")}.`);
        if (s.notBlocked.length)
          lines.push(`Not existing tests, nothing to ask: ${s.notBlocked.join(", ")}.`);
        const [first, ...rest] = s.ask;
        if (first) {
          const o = await ask(cx, m, testQuestion(first), "answer the question", v.brief);
          return {
            done: {
              ...o,
              data: {
                ...o.data,
                unplanned,
                testAsk: { ...first, rest },
                testNote: lines.join(" ") || undefined,
              },
            },
          };
        }
      }
      const fresh = cx.record(m, "access", {}, { unplanned, testNote: undefined });
      return spawnWorker(cx, fresh, [...lines, "Continue the build."].join(" "));
    }
    return commit(
      cx,
      cx.record(
        m,
        "commit",
        {},
        {
          build: { pr: v.pr, notes: v.notes, planChanged: v.plan_changed, brief: v.brief },
          testNote: undefined,
        },
      ),
    );
  },
};

/**
 * PIP-116: the owner answered the question about a test: allowed → the file joins the grants,
 * anything else → refused for good. More tests asked in the same round are put one after the other.
 */
async function resolveTestAsk(cx: Ctx, m: Mission): Promise<{ done: Outcome } | { m: Mission }> {
  const d = data(m);
  const asked = d.testAsk!;
  let reply = d.answer;
  if (!reply) {
    const intent = await intentOf(cx, m);
    const last = (intent.sections.get("Answers") ?? "").trim().split("\n").filter(Boolean).at(-1);
    reply = last?.replace(/^-\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\s*/, "");
  }
  const r = answerTest(asked, d, reply);
  const note = [d.testNote, r.note].filter(Boolean).join(" ");
  const next = sortTestRequests(
    asked.rest,
    { ...d, ...r.patch },
    asked.rest.map((t) => t.path),
  ).ask;
  const [first, ...rest] = next;
  if (first) {
    const o = await ask(cx, m, testQuestion(first));
    return { done: { ...o, data: { ...o.data, ...r.patch, testAsk: { ...first, rest }, testNote: note } } };
  }
  return { m: cx.record(m, m.step, {}, { ...r.patch, testAsk: undefined, testNote: note }) };
}

async function setupOrWorker(cx: Ctx, m: Mission): Promise<Progress> {
  const d = data(m);
  if (d.setup === cx.checkout(m)) return spawnWorker(cx, m);
  const files = await repoFiles(cx, m);
  if (!files.verifying.setup.length)
    return spawnWorker(cx, cx.record(m, "setup-done", {}, { setup: cx.checkout(m) }));
  return {
    spawn: sandboxSpec(cx, m, {
      kind: "setup",
      lines: files.verifying.setup,
      dir: cx.checkout(m),
      network: true,
      cacheWritable: true,
      log: logPath(cx, m, "build", "build-setup.log"),
      timeoutMs: cx.config.agent.checkTimeoutMin * 60_000,
    }),
  };
}

/** Commit the round as the bot; nothing changed since base → `no changes`. */
async function commit(cx: Ctx, m: Mission): Promise<Progress> {
  const d = data(m);
  const intent = await intentOf(cx, m);
  await coGit(cx, m, ["add", "-A"]);
  const staged = (await coGit(cx, m, ["diff", "--cached", "--name-only"])).trim();
  // A conflict round's merge is committed even when the resolution kept this branch's side whole.
  const merging = await coGit(cx, m, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
    () => true,
    () => false,
  );
  if (staged || merging) {
    await coGit(cx, m, [...(await botAuthor(cx)), "commit", "--quiet", "-m", commitTitle(m, intent)]);
  }
  const repo = cx.repo(m);
  const ahead = (
    await coGit(cx, m, ["rev-list", "--count", `refs/remotes/origin/${repo.base}..HEAD`])
  ).trim();
  if (ahead === "0")
    return { done: wait("no changes", d.build?.notes ? d.build.notes.slice(0, 300) : undefined) };
  if (d.build?.planChanged) {
    try {
      await writePlanToMain(cx, intent, d.build.planChanged);
    } catch (e) {
      cx.log(`${m.intent}: couldn't write the changed plan: ${(e as Error).message}`);
    }
  }
  const head = (await coGit(cx, m, ["rev-parse", "HEAD"])).trim();
  const patch: Partial<PipeData> = { repair: undefined, answer: undefined, roundFrom: undefined };
  if (head === d.roundFrom && d.repair && d.repair.kind !== "conflict") {
    // A repair that changed nothing would only run the same red check again: ask the owner now.
    if (!d.answer) {
      const notes = d.build?.notes ? ` ${d.build.notes.slice(0, 300)}` : "";
      return { done: wait("no changes", `The repair round changed nothing.${notes}`) };
    }
    // The owner's words and still no change ("it's flaky, go on"): CI gets one more run of this head.
    if (d.repair.kind === "ci" && d.ci?.reruns)
      patch.ci = { ...d.ci, reruns: { ...d.ci.reruns, [head]: false } };
  }
  if (!d.repair) patch.lockHead = head;
  const files = await repoFiles(cx, m);
  void effectiveOf(m, intent, files);
  return { done: ok({ data: patch }) };
}

function readLog(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
