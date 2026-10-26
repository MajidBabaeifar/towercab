// The page's buttons (UI-66): each does what the owner would do on GitHub (as the owner, LOOP-38) or
// in the CLI (a `commands` row the loop applies, LOOP-15).

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock, GitHub } from "../handlers.ts";
import type { IntentStore } from "../intents/types.ts";
import { type Mission, unfinishedFor } from "../mission.ts";
import { currentPr } from "./state.ts";

/** What the page can do; each resolves to one sentence saying what happened, or throws the error. */
export interface UiActions {
  merge(intent: string): Promise<string>;
  reply(intent: string, text: string): Promise<string>;
  retry(intent: string): Promise<string>;
  drop(intent: string): Promise<string>;
  pause(): Promise<string>;
  resume(): Promise<string>;
}

export interface ActionDeps {
  db: Db;
  store: IntentStore;
  config: Config;
  clock: Clock;
  github: Pick<GitHub, "owner">;
}

export const MAX_REPLY = 20_000;

const APPROVALS = new Set(["approval:spec", "approval:plan", "approval:merge"]);

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

  return {
    async merge(intent) {
      const m = unfinishedFor(d.db, intent);
      if (!m || !APPROVALS.has(m.stage))
        throw new Error("Nothing to merge: this intent isn't waiting for a merge.");
      const p = pr(m);
      if (!p) throw new Error("Nothing to merge: its PR isn't open yet.");
      await owner(
        ["pr", "merge", String(p.number), "--squash", "-R", p.github],
        `merge the ${p.label} #${p.number}`,
      );
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
      const p = pr(unfinishedFor(d.db, intent));
      if (p) {
        await owner(
          ["pr", "comment", String(p.number), "-R", p.github, "--body", "/retry"],
          `comment on the ${p.label}`,
        );
        return `Asked for a fresh start on the ${p.label} #${p.number}. A new attempt begins within a minute.`;
      }
      command("retry", intent);
      return "Towercab starts it over on its next pass.";
    },

    async drop(intent) {
      const p = pr(unfinishedFor(d.db, intent));
      if (p) {
        await owner(["pr", "close", String(p.number), "-R", p.github], `close the ${p.label} #${p.number}`);
        return `Closed the ${p.label} #${p.number}; the intent is dropped.`;
      }
      command("drop", intent);
      return "Towercab drops it on its next pass.";
    },

    async pause() {
      command("pause");
      return "Paused: nothing new starts until you resume.";
    },

    async resume() {
      command("resume");
      return "Resumed: Towercab picks up work again.";
    },
  };
}
