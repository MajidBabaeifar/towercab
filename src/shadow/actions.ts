// What the shadow may do (SHD-6..10, SHD-12..14, SHD-19): one executor between the model's request and
// Towercab's own actions. Free actions run; merge, boost and drop wait for the owner's yes unless
// `[shadow].free` lists them; confirm always waits. Every action is recorded before it runs.

import { ownerOnly, ownerOnlyLine } from "../autonomy.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock } from "../handlers.ts";
import type { Intent, IntentStore } from "../intents/types.ts";
import { dataOf, type Mission, unfinishedFor } from "../mission.ts";
import type { UiActions } from "../ui/actions.ts";
import {
  type ActionRow,
  actionsOfTurn,
  type Pending,
  pendingActions,
  recordAction,
  savePending,
  setOutcome,
} from "./store.ts";

export const ACTIONS = ["reply", "start", "draft", "merge", "boost", "drop", "confirm", "pause"] as const;
type Action = (typeof ACTIONS)[number];

/** SHD-8: held for a yes unless `[shadow].free` lists them. SHD-14: `confirm` is always held. */
const HELD = new Set<Action>(["merge", "boost", "drop", "confirm"]);

/** SHD-10: a held action not answered in this long is dropped. */
export const PENDING_TTL_S = 24 * 3600;

/** The waits a merge may clear (the PR the owner would merge); every other wait is the owner's alone (SHD-9). */
const MERGE_WAITS = new Set(["approve spec", "approve plan", "review and merge PR"]);

export interface ActionReq {
  action: string;
  intent: string;
  repo: string;
  title: string;
  text: string;
}

export interface ExecDeps {
  db: Db;
  clock: Clock;
  config: Config;
  store: IntentStore;
  /** The page's actions with `actor: "shadow"`: replies carry the tag (SHD-12). */
  ui: UiActions;
  log(line: string): void;
  /** SHD-9: the PR's head commit now (read as the owner); none: the head isn't compared. */
  headOf?: (github: string, pr: number) => Promise<string>;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Executor {
  private d: ExecDeps;

  constructor(d: ExecDeps) {
    this.d = d;
  }

  /** Why `req` can't be done at all (before asking the owner), or null. */
  private async refusal(req: ActionReq, ownerText = ""): Promise<{ id: string; why: string } | null> {
    const { store, db } = this.d;
    if (req.action === "draft") {
      if (!this.d.config.repos.has(req.repo))
        return { id: "", why: `I don't know a repo called “${req.repo}”` };
      if (!req.title.trim() || /[\r\n]/.test(req.title))
        return { id: "", why: "a draft needs a one-line title" };
      return null;
    }
    let id: string;
    let found: Intent;
    try {
      found = await store.get(req.intent);
      id = found.id;
    } catch {
      return { id: "", why: `there is no open intent “${req.intent}”` };
    }
    // SHD-21, SHD-22: an a0 intent is the owner's alone, whatever `free` says and after a yes; the one
    // exception is a pause the owner's own latest message asked for.
    if (ownerOnly(found.a ?? null, unfinishedFor(db, id)?.a_at_pick ?? null)) {
      const asked = /\bpause\b/i.test(ownerText) && ownerText.includes(id);
      if (!(req.action === "pause" && asked)) return { id, why: ownerOnlyLine(id) };
    }
    if (req.action === "merge") {
      const m = unfinishedFor(db, id);
      if (!m || !MERGE_WAITS.has(m.waiting ?? "")) {
        return {
          id,
          why: "it isn't waiting on a merge that is yours to make (checks, a question or teammates come first)",
        };
      }
      // SHD-9: a code PR is merged only when nothing but the owner's approval holds it.
      if (m.waiting === "review and merge PR") {
        const why = await this.codeHold(m);
        if (why) return { id, why };
      }
    }
    if (req.action === "confirm" && (await store.get(id)).source !== "shadow") {
      return { id, why: "it isn't a draft of mine" };
    }
    if (req.action === "reply" && !req.text.trim()) return { id, why: "there is nothing to say" };
    return null;
  }

  /**
   * SHD-9: one line on why a code PR at "review and merge PR" is held by more than the owner's approval (CI
   * not green, no approving review, the head moved since, work Towercab didn't check), or null.
   */
  private async codeHold(m: Mission): Promise<string | null> {
    const d = dataOf<{
      ci?: { result?: string };
      review?: { approved?: boolean } | null;
      unproven?: boolean;
      foreignHead?: boolean;
      unplanned?: { domains: string[]; paths: string[] };
      build?: { planChanged?: string | null };
      teammate?: { passNeeded?: boolean };
    }>(m);
    if (d.ci?.result !== "green" && d.ci?.result !== "none") return "its checks aren't green yet";
    if (!d.review) return "it hasn't been reviewed yet";
    if (!d.review.approved) return "the review didn't approve it";
    if (d.teammate?.passNeeded) return "it still has to be passed on to your teammates";
    if (d.unproven) return "its tests weren't shown to fail before the change";
    if (d.foreignHead) return "someone else added commits to the PR";
    if (d.build?.planChanged) return "the build changed course from the approved plan";
    if ((d.unplanned?.domains.length ?? 0) + (d.unplanned?.paths.length ?? 0) > 0) {
      return "the build reached beyond the access the plan listed";
    }
    const repo = this.d.config.repos.get(m.repo)?.github;
    if (m.pr && repo && this.d.headOf) {
      let now: string;
      try {
        now = await this.d.headOf(repo, m.pr);
      } catch {
        return "I couldn't read the PR to check it hasn't changed";
      }
      if (m.head && now !== m.head) return "the PR changed after it was reviewed";
    }
    return null;
  }

  private prOf(intent: string): number {
    const m = intent ? unfinishedFor(this.d.db, intent) : undefined;
    if (!m) return 0;
    return (m.stage === "approval:spec" ? m.spec_pr : m.stage === "approval:plan" ? null : m.pr) ?? 0;
  }

  /**
   * SHD-6..10: one requested action. A free one runs now; a held one is stored and asked about. Returns one
   * line for the owner. The row is written first (SHD-19).
   */
  async request(turn: number, idx: number, req: ActionReq, ownerText = ""): Promise<string> {
    const { db, clock, config } = this.d;
    const now = clock.now();
    if (!(ACTIONS as readonly string[]).includes(req.action)) {
      recordAction(db, {
        at: now,
        turn,
        idx,
        action: req.action,
        intent: req.intent,
        pr: 0,
        outcome: "refused",
        detail: "not an action the shadow has",
      });
      return `I can't “${req.action}”: that isn't something I'm allowed to do.`;
    }
    const action = req.action as Action;
    const bad = await this.refusal(req, ownerText);
    const intent = bad?.id || req.intent;
    if (bad) {
      recordAction(db, { at: now, turn, idx, action, intent, pr: 0, outcome: "refused", detail: bad.why });
      return `I didn't ${action} ${intent || req.title}: ${bad.why}.`;
    }
    // SHD-9: freeing `merge` frees only the code PR's own merge; a spec or a plan still waits for a yes.
    const codeOnly = action !== "merge" || unfinishedFor(db, intent)?.waiting === "review and merge PR";
    const free = (config.shadow.free as string[]).filter((f) => f !== action || codeOnly);
    if (HELD.has(action) && (action === "confirm" || !free.includes(action))) {
      const have = pendingActions(db).find((p) => p.action === action && p.intent === intent);
      if (have) return `Still waiting for your yes: ${this.ask(have)}`;
      const row = recordAction(db, {
        at: now,
        turn,
        idx,
        action,
        intent,
        pr: this.prOf(intent),
        outcome: "held",
        detail: "waiting for your yes",
      });
      const p: Pending = { row, action, intent, repo: req.repo, title: req.title, text: req.text, at: now };
      savePending(db, [...pendingActions(db), p]);
      return this.ask(p);
    }
    const row = recordAction(db, {
      at: now,
      turn,
      idx,
      action,
      intent,
      pr: this.prOf(intent),
      outcome: "started",
    });
    return this.run(row, action, { ...req, intent });
  }

  private ask(p: Pending): string {
    const what = p.action === "confirm" ? `Make the draft ${p.intent} yours` : `${cap(p.action)} ${p.intent}`;
    return `${what}? Reply yes or no.`;
  }

  /** The effect of one action, after its row was written; the row ends `done` or `refused`. */
  private async run(row: number, action: Action, req: ActionReq): Promise<string> {
    const { db, store, ui, clock } = this.d;
    try {
      let said: string;
      switch (action) {
        case "reply":
          said = await ui.reply(req.intent, req.text);
          break;
        case "start":
          said = await ui.start(req.intent);
          break;
        case "pause":
          said = await ui.pause(req.intent);
          break;
        case "merge":
          said = await ui.merge(req.intent);
          break;
        case "drop":
          said = await ui.drop(req.intent);
          break;
        case "boost": {
          const i = await store.get(req.intent);
          const [u, v] = [Math.min(5, (i.u ?? 3) + 1), Math.min(5, (i.i ?? 3) + 1)];
          await store.update(
            req.intent,
            "[shadow] boost",
            (e) => {
              e.setField("u", u);
              e.setField("i", v);
            },
            "Shadow: true",
          );
          said = `Raised ${req.intent} to urgency ${u} and importance ${v}.`;
          break;
        }
        case "draft": {
          const made = await store.add(
            {
              repo: req.repo,
              title: req.title.trim(),
              u: 3,
              i: 3,
              a: 3,
              source: "shadow",
              by: "shadow",
              body: req.text,
              mark: "Shadow: true",
            },
            new Date(clock.now() * 1000),
          );
          req.intent = made.id;
          db.run("UPDATE shadow_actions SET intent = ? WHERE id = ?", made.id, row);
          said = `Drafted ${made.id}: ${made.title}. It is marked as mine until you confirm it.`;
          break;
        }
        case "confirm":
          await store.update(
            req.intent,
            "[shadow] confirm",
            (e) => e.setField("source", "me"),
            "Shadow: true",
          );
          said = `${req.intent} is yours now.`;
          break;
      }
      setOutcome(db, row, "done", said);
      return said;
    } catch (e) {
      const why = (e as Error).message;
      setOutcome(db, row, "refused", why);
      return `I didn't ${action} ${req.intent}: ${why}`;
    }
  }

  /**
   * SHD-10: the owner's yes or no, from the chat. With one action waiting it answers that one; with several
   * a bare yes or no answers none and asks which (`yes merge <id>`), so a yes can't land on a question it
   * wasn't meant for. The action is taken off the waiting list, its row set and the answering turn linked
   * to it in one transaction before anything runs (SHD-20): a restart reports it and never answers again.
   * A yes runs it once, checked again since things may have moved; a no cancels it.
   */
  async answer(
    yes: boolean,
    o: { turn?: number; target?: { action: string; intent: string } } = {},
  ): Promise<string> {
    const { db } = this.d;
    const list = pendingActions(db);
    if (!list.length) return "There is nothing waiting for your yes.";
    const mine = o.target
      ? list.filter(
          (x) =>
            x.action === o.target!.action &&
            (x.intent === o.target!.intent || x.intent.endsWith(o.target!.intent)),
        )
      : list;
    if (o.target && mine.length !== 1) {
      return `Nothing is waiting for “${o.target.action} ${o.target.intent}”. Waiting: ${list.map((x) => this.ask(x)).join(" ")}`;
    }
    if (mine.length > 1) {
      const say = yes ? "yes" : "no";
      return `More than one thing is waiting, so I haven't done any of them. ${list.map((x) => this.ask(x)).join(" ")} Say, for example, “${say} ${list[0]!.action} ${list[0]!.intent}”.`;
    }
    const p = mine[0]!;
    db.tx(() => {
      savePending(
        db,
        list.filter((x) => x !== p && x.row !== p.row),
      );
      db.run(
        "UPDATE shadow_actions SET outcome = ?, detail = ? WHERE id = ?",
        yes ? "started" : "refused",
        yes ? "" : "you said no",
        p.row,
      );
      if (o.turn !== undefined)
        db.run("UPDATE shadow_actions SET turn = ?, idx = 0 WHERE id = ?", o.turn, p.row);
    });
    const rest =
      list.length > 1
        ? ` Still waiting: ${list
            .filter((x) => x.row !== p.row)
            .map((x) => this.ask(x))
            .join(" ")}`
        : "";
    if (!yes) return `Okay, I won't ${p.action} ${p.intent}.${rest}`;
    const req: ActionReq = { action: p.action, intent: p.intent, repo: p.repo, title: p.title, text: p.text };
    const bad = await this.refusal(req);
    if (bad) {
      setOutcome(db, p.row, "refused", bad.why);
      return `I didn't ${p.action} ${p.intent}: ${bad.why}.${rest}`;
    }
    return `${await this.run(p.row, p.action as Action, req)}${rest}`;
  }

  /** SHD-10: held actions older than a day are dropped; one line each. */
  expire(): string[] {
    const { db, clock } = this.d;
    const now = clock.now();
    const list = pendingActions(db);
    const old = list.filter((p) => now - p.at >= PENDING_TTL_S);
    if (!old.length) return [];
    savePending(
      db,
      list.filter((p) => !old.includes(p)),
    );
    for (const p of old) setOutcome(db, p.row, "refused", "no answer in 24 hours");
    return old.map((p) => `I dropped “${p.action} ${p.intent}”: you didn't answer within 24 hours.`);
  }

  /**
   * A turn that stopped with actions on record (a crash, a restart): what each did, and a note on the
   * ones that were under way. They are not run again (SHD-20). Null when the turn has no action rows.
   */
  recover(turn: number): string | null {
    const rows: ActionRow[] = actionsOfTurn(this.d.db, turn);
    if (!rows.length) return null;
    const lines = rows.map((r) => {
      if (r.outcome === "started") {
        setOutcome(this.d.db, r.id, "refused", "interrupted by a restart");
        return `I was interrupted while doing “${r.action} ${r.intent}”: please check it.`;
      }
      if (r.outcome === "held")
        return this.ask(
          pendingActions(this.d.db).find((p) => p.row === r.id) ?? {
            row: r.id,
            action: r.action,
            intent: r.intent,
            repo: "",
            title: "",
            text: "",
            at: r.at,
          },
        );
      return r.outcome === "done"
        ? r.detail || `Did ${r.action} ${r.intent}.`
        : `I didn't ${r.action} ${r.intent}: ${r.detail}`;
    });
    return lines.join("\n");
  }
}
