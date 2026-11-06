// The shadow's connections to the rest of Towercab (SHD-4, SHD-5): its state snapshot, its reads and
// its actions, all from the code the page uses. Nothing here gives it a shell or a token.

import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { ownerForge } from "../github/forge.ts";
import type { Clock, GitHub, Host } from "../handlers.ts";
import type { Home } from "../home.ts";
import type { IntentStore } from "../intents/types.ts";
import type { Loop } from "../loop.ts";
import type { Telegram } from "../telegram.ts";
import type { Tools } from "../tools.ts";
import { createActions } from "../ui/actions.ts";
import { repos } from "../ui/repos.ts";
import { activity, intentPage, overview, queue, RUN_NAME, redact, type UiSources } from "../ui/state.ts";
import { sourcesOf } from "../ui/wire.ts";
import { Executor } from "./actions.ts";
import { stateText } from "./prompt.ts";
import { Shadow } from "./shadow.ts";
import { costToday, pendingActions, recentActions } from "./store.ts";

const REPO_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,7})$/;

/** SHD-5: the reads the session may ask for; each returns text, redacted, and is data to the session (SHD-3). */
export function shadowReads(
  src: UiSources,
  github: Pick<GitHub, "owner">,
): (kind: string, ref: string) => Promise<string> {
  const json = (v: unknown) => redact(JSON.stringify(v, null, 1), src.config);
  return async (kind, ref) => {
    switch (kind) {
      case "intent": {
        const p = await intentPage(src, ref.trim());
        if (!p) throw new Error(`there is no intent ${ref}`);
        return json({
          id: p.id,
          title: p.title,
          repo: p.repo,
          scores: p.scores,
          state: p.state,
          sentence: p.sentence,
          prs: p.prs,
          wait: p.card && { kind: p.card.kindLabel, ask: p.card.ask, brief: p.card.brief, why: p.card.why },
          timeline: p.timeline.slice(-15).map((t) => ({ at: t.at.exact, text: t.text, why: t.why })),
          answers: p.answers,
        });
      }
      case "queue":
        return json(await queue(src));
      case "activity": {
        const a = await activity(src, { intent: ref.trim() || undefined, offset: 0 });
        return json(a);
      }
      case "repos": {
        const page = await repos(src, null, {});
        return json(page);
      }
      case "pr": {
        const m = REPO_REF.exec(ref.trim());
        const known = new Set([...src.config.repos.values()].map((r) => r.github));
        const intents = src.store.github();
        if (intents) known.add(intents);
        if (!m || !known.has(m[1]!))
          throw new Error("pr needs owner/name#number of a repo Towercab works in");
        const of = ownerForge(github.owner);
        const n = Number(m[2]);
        const [brief, files] = await Promise.all([of.prBrief(m[1]!, n), of.prFiles(m[1]!, n)]);
        return json({ repo: m[1], number: n, ...brief, files: files.slice(0, 40) });
      }
      case "runfile":
        return runFile(src.home.root, ref.trim());
      default:
        throw new Error(`unknown read “${kind}”`);
    }
  };
}

/** The end of a run file, `<intent>/<file>` or `<intent>/<stage>/<file>`, inside `runs/` only. */
function runFile(root: string, ref: string): string {
  const parts = ref.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !RUN_NAME.test(p) || p.startsWith("."))) {
    throw new Error("runfile needs <intent id>/<file> or <intent id>/<stage>/<file>");
  }
  const dir = join(root, "runs", parts[0]!);
  const file = join(dir, ...parts.slice(1));
  const st = lstatSync(file);
  if (!st.isFile() || !realpathSync(file).startsWith(realpathSync(dir) + sep))
    throw new Error("no such run file");
  const length = Math.min(Number(st.size), 8_000);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, Number(st.size) - length);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

export interface ShadowWorld {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: Host;
  log(line: string): void;
}

/** The shadow for `towercab run --watch`: `loop` is read when a turn needs the state, not before. */
export function buildShadow(w: ShadowWorld, telegram: Telegram | null, loop: () => Loop): Shadow {
  const src = () => sourcesOf(loop(), w.home);
  const ui = createActions({
    db: w.db,
    store: w.store,
    config: w.config,
    clock: w.clock,
    github: w.github,
    actor: "shadow",
    proposed: () => loop().proposedState().list,
  });
  const exec = new Executor({ db: w.db, clock: w.clock, config: w.config, store: w.store, ui, log: w.log });
  return new Shadow({
    ...w,
    telegram,
    exec,
    read: (kind, ref) => shadowReads(src(), w.github)(kind, ref),
    snapshot: async () => {
      const s = src();
      const ov = await overview(s);
      return stateText(ov, {
        pending: pendingActions(w.db),
        recent: recentActions(w.db, 8),
        spent: costToday(w.db, w.clock.now()),
        cap: w.config.shadow.dailyBudgetUsd,
        repos: [...w.config.repos.keys()],
      });
    },
  });
}
