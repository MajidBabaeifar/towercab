// The page's buttons (UI-66): each does what the owner would do on GitHub (as the owner, LOOP-38) or
// in the CLI (a `commands` row the loop applies, LOOP-15).

import { tickSteps } from "../commands.ts";
import type { Config, RepoConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { askFeatures } from "../features.ts";
import { ForgeBadReply, MERGE_METHOD, type PrBrief, type Result } from "../forge.ts";
import { ownerForge } from "../github/forge.ts";
import { classifyFiles, type ProposedPr } from "../github/proposed.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { IntentStore } from "../intents/types.ts";
import { dataOf, getMission, type Mission, unfinishedFor } from "../mission.ts";
import { grantScanning } from "../pipeline/alerts.ts";
import { ownerMergeRefusal } from "../pipeline/teammate.ts";
import { grantPermission } from "../settings/store.ts";
import { approveSecret } from "../ship/secret-steps.ts";
import { currentPr, type DoneNote, validNote } from "./state.ts";

/** What the page can do; each resolves to one sentence saying what happened, or throws the error. */
export interface UiActions {
  merge(intent: string): Promise<string>;
  reply(intent: string, text: string): Promise<string>;
  retry(intent: string): Promise<string>;
  drop(intent: string): Promise<string>;
  start(intent: string): Promise<string>;
  /** UI-168, PIP-143: pass a change the automated review didn't approve on to the teammates. */
  pass?(intent: string): Promise<string>;
  /** UI-160, SHIP-22: tick (or untick) one of the owner's steps. */
  step?(intent: string, n: number, done: boolean): Promise<string>;
  /** REPO-32: the owner granted the App Administration (write); settings are applied again. */
  granted?(): Promise<string>;
  /** PIP-150: the owner granted the App Code scanning alerts (read); alerts are read again. */
  scanningGranted?(): Promise<string>;
  /** UI-164, LOOP-76: "I did it myself": ends the intent; the note becomes a ticked step. */
  done?(intent: string, note: string): Promise<string>;
  /** UI-164, PIP-113: the owner does it by hand; the intent becomes steps. */
  steps?(intent: string): Promise<string>;
  pause(): Promise<string>;
  resume(): Promise<string>;
  /** UI-130: add `owner/name` as a repo (`name` = its short name, default the repo part). */
  addRepo(github: string, name?: string): Promise<string>;
  /** UI-144: read the repo again for its feature list (INT-39). */
  features(repo: string): Promise<string>;
  /** SHIP-35: write the value the owner typed for a supplied secret (never stored, never echoed). */
  secret?(intent: string, n: number, value: string): Promise<string>;
  /** SHIP-34: approve a secret's pull request, or ask to try again after repeated failures. */
  approveSecret?(intent: string, n: number): Promise<string>;
  /** INT-53: merge the proposed intent's PR `pr` as the owner, if it still is at `head`. */
  accept(pr: number, head: string): Promise<string>;
  /** INT-53: comment `text` (default `Not going ahead.`) and close the proposed intent's PR. */
  close(pr: number, text?: string): Promise<string>;
}

export interface ActionDeps {
  db: Db;
  store: IntentStore;
  config: Config;
  clock: Clock;
  github: Pick<GitHub, "owner">;
  /**
   * LOOP-66's checks, bound to the loop's database, config, tools and home: resolves with the repo once
   * they pass, while the clone goes on (UI-130); null: refused.
   */
  addRepo?: ((github: string, name?: string) => Promise<RepoConfig>) | null;
  /** The loop's last list of proposed intents (LOOP-92); Accept refuses one whose file can't be read. */
  proposed?: () => ProposedPr[];
  /** SHIP-35: writes a typed secret; none: the page can't take one. */
  supplySecret?: (intent: string, n: number, value: string) => Promise<string>;
}

export const DEFAULT_CLOSE_REASON = "Not going ahead.";

export const MAX_REPLY = 20_000;

const APPROVALS = new Set(["approval:spec", "approval:plan", "approval:merge"]);

const PAST = {
  merge: "merged",
  drop: "dropped",
  retry: "started over",
  done: "marked it done",
  steps: "switched it to steps",
} as const;

function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "no reason given"
  );
}

export function createActions(d: ActionDeps): UiActions {
  const command = (name: string, arg = "", text = "") => {
    d.db.run(
      "INSERT INTO commands (name, arg, text, source, created) VALUES (?, ?, ?, 'ui', ?)",
      name,
      arg,
      text,
      d.clock.now(),
    );
  };
  const pr = (m: Mission | undefined) => (m ? currentPr(m, d.config, d.store.github()) : null);
  const of = ownerForge(d.github.owner);
  const refused = (r: Result, what: string) => {
    if (!r.ok) throw new Error(`GitHub refused to ${what}: ${firstLine(r.reason)}`);
  };

  /** UI-105, UI-106: remember the action for display and ask the loop to read the PR on its next pass. */
  const done = (m: Mission, p: { number: number } | null, action: DoneNote["action"]) => {
    const note: DoneNote = { action, stage: m.stage, pr: p?.number ?? 0, at: d.clock.now() };
    d.db.tx(() => {
      const fresh = getMission(d.db, m.id);
      if (!fresh || fresh.stage !== m.stage) return;
      const data = { ...dataOf(fresh), doneByYou: note };
      d.db.run("UPDATE missions SET data = ? WHERE id = ?", JSON.stringify(data), m.id);
      d.db.setMeta(`poll:${m.id}`, "1");
    });
  };
  /** A repeat of what the note says: nothing to send to GitHub (UI-107). */
  const repeated = (m: Mission, p: { number: number; label: string }, action: DoneNote["action"]) => {
    const n = validNote(m, p);
    if (!n) return null;
    if (n.action !== action) {
      throw new Error(`You already ${PAST[n.action]} the ${p.label} #${p.number}; Towercab is moving on.`);
    }
    return `Already ${PAST[action]}; Towercab is moving on.`;
  };

  /** INT-53: the PR as GitHub has it now, read as the owner. */
  const look = async (n: number) => {
    const repo = d.store.github();
    if (!repo) throw new Error("Towercab doesn't know the intents repo's GitHub name.");
    let v: PrBrief;
    try {
      v = await of.prBrief(repo, n);
    } catch (e) {
      if (e instanceof ForgeBadReply) throw new Error(`GitHub gave no state for PR #${n}.`);
      throw new Error(`GitHub refused to read PR #${n}: ${firstLine((e as Error).message)}`);
    }
    return { repo, state: v.state, draft: v.draft, head: v.head };
  };
  const files = async (repo: string, n: number) => {
    try {
      return classifyFiles(await of.prFiles(repo, n));
    } catch (e) {
      throw new Error(`GitHub refused to read PR #${n}'s files: ${firstLine((e as Error).message)}`);
    }
  };
  const changed = (n: number) => new Error(`PR #${n} changed since you looked: check it and try again`);
  /** Ask the loop to read the intents repo's PRs now (UI-106's way). */
  const readNow = () => d.db.setMeta("proposed:poll", "1");

  return {
    async accept(n, head) {
      const now = await look(n);
      if (now.state !== "OPEN" || now.head !== head) throw changed(n);
      const c = await files(now.repo, n);
      if (!c || c.reason !== null) throw changed(n);
      const known = d.proposed?.().find((p) => p.number === n);
      if (known && !known.acceptable) throw changed(n);
      if (now.draft) refused(await of.markReady(now.repo, n), `mark PR #${n} ready`);
      refused(await of.mergePr(now.repo, n, { method: MERGE_METHOD, head }), `merge PR #${n}`);
      readNow();
      return `Merged PR #${n} as you. The intent is on main; Towercab picks it up within a minute.`;
    },

    async close(n, text) {
      const now = await look(n);
      if (now.state !== "OPEN") {
        readNow();
        return `PR #${n} is already ${now.state === "MERGED" ? "merged" : "closed"}; nothing to do.`;
      }
      if (!(await files(now.repo, n)))
        throw new Error(`PR #${n} doesn't add an intent, so it isn't closed from here.`);
      const why = text?.trim() || DEFAULT_CLOSE_REASON;
      refused(await of.closePr(now.repo, n, why), `close PR #${n}`);
      readNow();
      return `Closed PR #${n}. The intent never reaches main.`;
    },

    async merge(intent) {
      const m = unfinishedFor(d.db, intent);
      if (!m || !APPROVALS.has(m.stage))
        throw new Error("Nothing to merge: this intent isn't waiting for a merge.");
      // PIP-143: a change the automated review didn't approve is passed on before it can merge.
      if ((dataOf(m) as { teammate?: { passNeeded?: boolean } }).teammate?.passNeeded === true) {
        throw new Error("Pass it on to your teammates first: they need to review it before it can merge.");
      }
      // PIP-144: the owner's Merge waits for the teammates' approval.
      if (m.waiting === "teammate review" || m.waiting === "teammate review of spec") {
        const repo = d.config.repos.get(m.repo);
        throw new Error(
          `Waiting for teammate review (${repo?.reviewers?.join(", ") || "the code owners"}): you can merge once they have approved.`,
        );
      }
      // PIP-144: where the gate didn't check for a teammate approval, the owner's merge does.
      const cfg = d.config.repos.get(m.repo);
      const refusal = cfg
        ? await ownerMergeRefusal({ owner: d.github.owner, me: d.config.github?.me ?? "", repo: cfg, m })
        : null;
      if (refusal) throw new Error(refusal);
      const p = pr(m);
      if (!p) throw new Error("Nothing to merge: its PR isn't open yet.");
      const again = repeated(m, p, "merge");
      if (again) return again;
      let state: PrBrief;
      try {
        state = await of.prBrief(p.github, p.number);
      } catch (e) {
        if (e instanceof ForgeBadReply)
          throw new Error(`GitHub gave no state for the ${p.label} #${p.number}.`);
        throw new Error(
          `GitHub refused to read the ${p.label} #${p.number}: ${firstLine((e as Error).message)}`,
        );
      }
      if (state.state === "MERGED" || state.merged) {
        done(m, p, "merge");
        return "Already merged; Towercab is moving on.";
      }
      if (state.state === "CLOSED") {
        throw new Error(`The ${p.label} #${p.number} is closed, so there is nothing to merge.`);
      }
      refused(
        await of.mergePr(p.github, p.number, { method: MERGE_METHOD }),
        `merge the ${p.label} #${p.number}`,
      );
      done(m, p, "merge");
      return `Merged the ${p.label} #${p.number} as you. Towercab moves on within a minute.`;
    },

    async pass(intent) {
      const m = unfinishedFor(d.db, intent);
      const t = m ? (dataOf(m) as { teammate?: { passNeeded?: boolean } }).teammate : undefined;
      if (m?.stage !== "approval:merge" || m.waiting !== "review and merge PR" || !t?.passNeeded) {
        throw new Error(
          "Nothing to pass on: this change isn't waiting for you to pass it to your teammates.",
        );
      }
      const p = pr(m);
      if (!p) throw new Error("Nothing to pass on: its PR isn't open yet.");
      // The same comment the owner can write on GitHub, so there is one way in (PIP-143).
      refused(await of.commentOnPr(p.github, p.number, "/pass", { inline: true }), "pass it on");
      d.db.setMeta(`poll:${m.id}`, "1");
      return `Passed on: Towercab asks your teammates within a minute.`;
    },

    async reply(intent, text) {
      const body = text.trim();
      if (!body) throw new Error("Write a reply first.");
      if (body.length > MAX_REPLY) throw new Error(`The reply is too long: at most ${MAX_REPLY} characters.`);
      const m = unfinishedFor(d.db, intent);
      const p = pr(m);
      if (p) {
        refused(
          await of.commentOnPr(p.github, p.number, body, { inline: true }),
          `comment on the ${p.label}`,
        );
        return `Replied on the ${p.label} #${p.number}. Towercab picks it up within a minute.`;
      }
      command("answer", intent, body);
      return "Answer saved to the intent. Towercab goes on with it on its next pass.";
    },

    async granted() {
      return grantPermission(d.db)
        ? "Noted. Towercab applies the standard settings again at its next check."
        : "Nothing to clear: the GitHub App was not missing the permission.";
    },

    async scanningGranted() {
      return grantScanning(d.db)
        ? "Noted. Towercab reads code scanning alerts again on the next red check."
        : "Nothing to clear: the GitHub App was not missing the permission.";
    },

    async retry(intent) {
      const m = unfinishedFor(d.db, intent);
      const p = pr(m);
      if (m && p) {
        const again = repeated(m, p, "retry");
        if (again) return again;
        refused(
          await of.commentOnPr(p.github, p.number, "/retry", { inline: true }),
          `comment on the ${p.label}`,
        );
        done(m, p, "retry");
        return `Asked for a fresh start on the ${p.label} #${p.number}. A new attempt begins within a minute.`;
      }
      command("retry", intent);
      return "Towercab starts it over on its next pass.";
    },

    async drop(intent) {
      const m = unfinishedFor(d.db, intent);
      const p = pr(m);
      if (m && p) {
        const again = repeated(m, p, "drop");
        if (again) return again;
        refused(await of.closePr(p.github, p.number), `close the ${p.label} #${p.number}`);
        done(m, p, "drop");
        return `Closed the ${p.label} #${p.number}; the intent is dropped.`;
      }
      command("drop", intent);
      return "Towercab drops it on its next pass.";
    },

    async start(intent) {
      if (unfinishedFor(d.db, intent)) throw new Error("It has already started.");
      command("start", intent);
      return "Starting its design on the next pass, even if the repo is full.";
    },

    async pause() {
      command("pause");
      return "Paused: nothing new starts until you resume.";
    },

    async step(intent, n, done) {
      // The same transaction as `towercab step`; the loop writes the tick to plan.md and goes on.
      return tickSteps(d.db, intent, [n], done, new Date(d.clock.now() * 1000));
    },

    async secret(intent, n, value) {
      if (!d.supplySecret) throw new Error("Secrets aren't available.");
      return d.supplySecret(intent, n, value);
    },

    async approveSecret(intent, n) {
      return approveSecret(d.db, d.clock, intent, n);
    },

    async done(intent, note) {
      const m = unfinishedFor(d.db, intent);
      if (!m) throw new Error("Nothing to finish: this intent isn't waiting on you.");
      command("done", intent, note.trim().slice(0, 300));
      done(m, pr(m), "done");
      return "Marked as done by you. Towercab ends the intent on its next pass.";
    },

    async steps(intent) {
      const m = unfinishedFor(d.db, intent);
      if (!m) throw new Error("Nothing to switch: this intent isn't waiting on you.");
      command("steps", intent);
      done(m, pr(m), "steps");
      return "Switched to steps for you to do. Towercab sets it up on its next pass.";
    },

    async resume() {
      command("resume");
      return "Resumed: Towercab picks up work again.";
    },

    async addRepo(github, name) {
      if (!d.addRepo) throw new Error("Towercab isn't running, so it can't add a repo now.");
      const r = await d.addRepo(github, name);
      return `Adding ${r.name} (${r.github}, base ${r.base}): Towercab is cloning it now. It shows on the Repos page when done, and its intents start from then on.`;
    },

    async features(repo) {
      if (!d.config.repos.has(repo)) throw new Error(`Towercab doesn't know a repo named ${repo}.`);
      if (!askFeatures(d.db, repo, d.clock.now()))
        return "Towercab is already reading the repo for its feature list.";
      return "Towercab reads the repo's README and specs and rewrites its live features within a few minutes.";
    },
  };
}
