// The page's buttons (UI-66): each does what the owner would do on GitHub (as the owner, LOOP-38) or
// in the CLI (a `commands` row the loop applies, LOOP-15).

import { tickSteps } from "../commands.ts";
import type { Config, RepoConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { askFeatures } from "../features.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { IntentStore } from "../intents/types.ts";
import { dataOf, getMission, type Mission, unfinishedFor } from "../mission.ts";
import { currentPr, type DoneNote, validNote } from "./state.ts";

/** What the page can do; each resolves to one sentence saying what happened, or throws the error. */
export interface UiActions {
  merge(intent: string): Promise<string>;
  reply(intent: string, text: string): Promise<string>;
  retry(intent: string): Promise<string>;
  drop(intent: string): Promise<string>;
  start(intent: string): Promise<string>;
  /** UI-160, SHIP-22: tick (or untick) one of the owner's steps. */
  step?(intent: string, n: number, done: boolean): Promise<string>;
  pause(): Promise<string>;
  resume(): Promise<string>;
  /** UI-130: add `owner/name` as a repo (`name` = its short name, default the repo part). */
  addRepo(github: string, name?: string): Promise<string>;
  /** UI-144: read the repo again for its feature list (INT-39). */
  features(repo: string): Promise<string>;
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
}

export const MAX_REPLY = 20_000;

const APPROVALS = new Set(["approval:spec", "approval:plan", "approval:merge"]);

const PAST = { merge: "merged", drop: "dropped", retry: "started over" } as const;

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
  const owner = async (args: string[], what: string) => {
    const r = await d.github.owner(args);
    if (r.code !== 0) throw new Error(`GitHub refused to ${what}: ${firstLine(r.stderr || r.stdout)}`);
  };

  /** UI-105, UI-106: remember the action for display and ask the loop to read the PR on its next pass. */
  const done = (m: Mission, p: { number: number }, action: DoneNote["action"]) => {
    const note: DoneNote = { action, stage: m.stage, pr: p.number, at: d.clock.now() };
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

  return {
    async merge(intent) {
      const m = unfinishedFor(d.db, intent);
      if (!m || !APPROVALS.has(m.stage))
        throw new Error("Nothing to merge: this intent isn't waiting for a merge.");
      const p = pr(m);
      if (!p) throw new Error("Nothing to merge: its PR isn't open yet.");
      const again = repeated(m, p, "merge");
      if (again) return again;
      const view = await d.github.owner([
        "pr",
        "view",
        String(p.number),
        "-R",
        p.github,
        "--json",
        "state,mergedAt",
      ]);
      if (view.code !== 0) {
        throw new Error(
          `GitHub refused to read the ${p.label} #${p.number}: ${firstLine(view.stderr || view.stdout)}`,
        );
      }
      let state: { state?: unknown; mergedAt?: unknown };
      try {
        state = JSON.parse(view.stdout) as typeof state;
      } catch {
        throw new Error(`GitHub gave no state for the ${p.label} #${p.number}.`);
      }
      if (state.state === "MERGED" || state.mergedAt) {
        done(m, p, "merge");
        return "Already merged; Towercab is moving on.";
      }
      if (state.state === "CLOSED") {
        throw new Error(`The ${p.label} #${p.number} is closed, so there is nothing to merge.`);
      }
      await owner(
        ["pr", "merge", String(p.number), "--squash", "-R", p.github],
        `merge the ${p.label} #${p.number}`,
      );
      done(m, p, "merge");
      return `Merged the ${p.label} #${p.number} as you. Towercab moves on within a minute.`;
    },

    async reply(intent, text) {
      const body = text.trim();
      if (!body) throw new Error("Write a reply first.");
      if (body.length > MAX_REPLY) throw new Error(`The reply is too long: at most ${MAX_REPLY} characters.`);
      const m = unfinishedFor(d.db, intent);
      const p = pr(m);
      if (p) {
        await owner(
          ["pr", "comment", String(p.number), "-R", p.github, "--body", body],
          `comment on the ${p.label}`,
        );
        return `Replied on the ${p.label} #${p.number}. Towercab picks it up within a minute.`;
      }
      command("answer", intent, body);
      return "Answer saved to the intent. Towercab goes on with it on its next pass.";
    },

    async retry(intent) {
      const m = unfinishedFor(d.db, intent);
      const p = pr(m);
      if (m && p) {
        const again = repeated(m, p, "retry");
        if (again) return again;
        await owner(
          ["pr", "comment", String(p.number), "-R", p.github, "--body", "/retry"],
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
        await owner(["pr", "close", String(p.number), "-R", p.github], `close the ${p.label} #${p.number}`);
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
