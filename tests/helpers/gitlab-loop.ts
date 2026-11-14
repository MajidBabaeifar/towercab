// A loop over a fake GitLab (GL-13, GL-14, GL-16): the real `routed` host with `GitLabHost` for `gitlab:`
// repos and the `Pipe` world's fake for GitHub ones. Every stage is a handler that only polls, so a test
// moves a mission by what the merge request says.

import { appendFileSync } from "node:fs";
import type { Config } from "../../src/config.ts";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { GitLabHost } from "../../src/forge/gitlab-host.ts";
import { type Routed, routed } from "../../src/forge/route.ts";
import type { Handlers } from "../../src/handlers.ts";
import type { IntentStore } from "../../src/intents/types.ts";
import { ORDER } from "../../src/machine.ts";
import { getMission, insertMission, type Mission } from "../../src/mission.ts";
import { intent, TARGET } from "./flows.ts";
import { gitlabConfig } from "./gitlab.ts";
import { FakeGitLabTimes } from "./gitlab-times.ts";
import { Pipe } from "./pipe.ts";

export const CODE_SLUG = "gitlab:group/web";
export const PLAN_SLUG = "gitlab:group/intents";
export const PUSH = "2026-11-05T10:00:00Z";
export const AFTER = "2026-11-05T10:01:00Z";

/** Handlers that only wait: the world moves a mission, not a stage. */
export function idleHandlers(): Handlers {
  const h = { step: async () => ({ poll: 30 }), finish: async () => ({ poll: 0 }) };
  return Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h])) as unknown as Handlers;
}

export interface GitlabLoop {
  p: Pipe;
  gl: FakeGitLabTimes;
  host: Routed;
  config: () => Config;
  /** One pass, then a minute and a bit. */
  pass(n?: number): Promise<void>;
  /** A mission waiting at `stage` on the merge request(s) given. */
  wait(o: { stage: string; waiting: string; pr?: number; plan_pr?: number; spec_pr?: number }): Mission;
  mission(id: number): Mission;
  events(): string[];
}

export async function gitlabLoop(
  o: { code?: "gitlab" | "github"; intents?: "gitlab" | "github"; me?: string } = {},
): Promise<GitlabLoop> {
  const gl = new FakeGitLabTimes();
  gl.project("group/web");
  gl.project("group/intents");
  const p = new Pipe(TARGET, {
    "intents/261001-0900-t0/intent.md": intent({ title: "T0", repo: "web", u: 4, i: 4, extra: "" }),
  });
  const { raw, cfg } = gitlabConfig({ me: o.me ?? "owner" });
  const host = routed(p.forge, new GitLabHost(new GitLabForge({ ...cfg, me: o.me ?? "owner" }, gl.http)));
  p.github = () => host;
  appendFileSync(
    p.gitconfig,
    `[url "${p.bares.intents}"]\n\tinsteadOf = https://gitlab.test/group/intents.git\n`,
  );
  const codeOnGitlab = (o.code ?? "gitlab") === "gitlab";
  const intents = (o.intents ?? "github") === "gitlab";
  // A GitLab repo lives in the database only (GL-3); the row is there before the loop opens.
  p.db.run(
    "INSERT INTO repos (name, github, path, base, workers, ahead, env, source, added) VALUES ('web', ?, '', 'main', 1, 3, '{}', 'cli', 0)",
    codeOnGitlab ? CODE_SLUG : "owner/web",
  );
  await p.start(
    {
      ...raw,
      ...(intents ? { intents: { remote: PLAN_SLUG, cutoff: 1 } } : {}),
    },
    {
      handlers: idleHandlers(),
      wrapStore: (s: IntentStore) => {
        const wrapped = Object.create(s) as IntentStore;
        wrapped.github = () => (intents ? PLAN_SLUG : "owner/intents");
        return wrapped;
      },
    },
  );
  const config = () => p.config(raw);
  return {
    p,
    gl,
    host,
    config,
    async pass(n = 1) {
      for (let i = 0; i < n; i++) {
        await p.loop.pass();
        p.clock.advance(61);
      }
    },
    wait(w) {
      const m0 = insertMission(
        p.db,
        { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 },
        0,
      );
      p.db.run(
        "UPDATE missions SET stage = ?, step = '', pr = ?, plan_pr = ?, spec_pr = ?, waiting = ?, feedback_seen = ? WHERE id = ?",
        w.stage,
        w.pr ?? null,
        w.plan_pr ?? null,
        w.spec_pr ?? null,
        w.waiting,
        "2026-11-05T00:00:00Z",
        m0.id,
      );
      return getMission(p.db, m0.id)!;
    },
    mission: (id) => getMission(p.db, id)!,
    events: () =>
      p.db.all<{ event: string }>("SELECT event FROM transitions ORDER BY id").map((r) => r.event),
  };
}
