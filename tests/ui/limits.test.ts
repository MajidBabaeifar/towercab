// UI-150 to UI-154: a repo's limits on its page: the form's data, the pending mark, the file's reason
// when it can't be read, the one-time move and the actions behind the buttons.

import { afterEach, expect, test } from "vitest";
import { errorKey, movedKey, PARSER_KEY, prKey } from "../../src/repo/settings.ts";
import { createActions } from "../../src/ui/actions.ts";
import { board } from "../../src/ui/board.ts";
import { repos } from "../../src/ui/repos.ts";
import { startUi } from "../../src/ui/server.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { call, post } from "./http.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function fixture(): Fixture {
  const f = buildFixture({ now: NOW });
  cleanup.push(() => f.cleanup());
  return f;
}
const limitsOf = async (f: Fixture) => (await repos(f.sources, "web")).repo!.limits;
const record = (pr: number, state: string, changes: object = {}) =>
  JSON.stringify({ pr, n: 1, changes, state });

test("ui: a repo page shows its settings", async () => {
  const f = fixture();
  const cfg = f.sources.config.repos.get("web")!;
  const l = await limitsOf(f);
  expect(l).toMatchObject({
    values: { workers: cfg.workers, ahead: cfg.ahead },
    defaults: { workers: 1, ahead: 3 },
    inFile: { workers: false, ahead: false },
    pending: null,
    moved: false,
    fileError: null,
    waitHours: 24,
    canSave: true,
    move: { state: "waiting", pr: null, canOpen: true },
  });
  // The file's values show as set, and a moved repo says so.
  f.db.setMeta("repo-file:web", JSON.stringify({ workers: 4 }));
  f.db.setMeta(movedKey("web"), String(NOW));
  expect(await limitsOf(f)).toMatchObject({ inFile: { workers: true, ahead: false }, moved: true });
  // The All view has no form.
  expect((await repos(f.sources, null)).repo).toBeNull();
});

test("ui: env names show but never values", async () => {
  const f = fixture();
  f.sources.config.repos.get("web")!.env = { NPM_TOKEN: "s3cret-value", AWS_REGION: "eu-west-1" };
  const page = await repos(f.sources, "web");
  expect(page.repo!.limits.envNames).toEqual(["AWS_REGION", "NPM_TOKEN"]);
  expect(JSON.stringify(page)).not.toContain("s3cret-value");
  expect(JSON.stringify(page)).not.toContain("eu-west-1");
});

test("ui: an invalid setting is refused in the form and by the server", async () => {
  const f = fixture();
  const seen: unknown[] = [];
  const actions = createActions({
    db: f.db,
    store: f.store,
    config: f.sources.config,
    clock: f.sources.clock,
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
    limits: {
      propose: async (repo, changes, confirmed) => {
        seen.push([repo, changes, confirmed]);
        const { validateChanges } = await import("../../src/repo/settings.ts");
        validateChanges(changes);
        return "Opened PR #1. The change applies after it is merged.";
      },
      move: async () => "Opened PR #2.",
    },
  });
  const ui = startUi({ port: 0, sources: f.sources, actions, distDir: tempDir(), log: () => {} });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const ok = await post(port, ui.token, { action: "repo-settings", repo: "web", changes: { workers: 2 } });
  expect(ok.status).toBe(200);
  expect(seen.at(-1)).toEqual(["web", { workers: 2 }, false]);
  const bad = await post(port, ui.token, { action: "repo-settings", repo: "web", changes: { workers: 0 } });
  expect(bad.status).toBe(422);
  expect(JSON.parse(bad.body).message).toBe("workers: 0 isn't a whole number from 1 to 16");
  expect((await post(port, ui.token, { action: "repo-settings", repo: "../x", changes: {} })).status).toBe(
    400,
  );
  const confirmed = await post(port, ui.token, {
    action: "repo-settings",
    repo: "web",
    changes: { ahead: 5 },
    confirmed: true,
  });
  expect(confirmed.status).toBe(200);
  expect(seen.at(-1)).toEqual(["web", { ahead: 5 }, true]);
  // The buttons' second action.
  const move = await post(port, ui.token, { action: "repo-move", repo: "web" });
  expect(JSON.parse(move.body)).toEqual({ ok: true, message: "Opened PR #2." });
});

test("ui: a pending setting shows its PR", async () => {
  const f = fixture();
  const github = f.sources.config.repos.get("web")!.github;
  f.db.setMeta(prKey("web", "settings"), record(7, "open", { workers: 3, ahead: null }));
  expect((await limitsOf(f)).pending).toEqual({
    pr: 7,
    url: `https://github.com/${github}/pull/7`,
    changes: { workers: 3, ahead: null },
  });
});

test("ui: the pending mark clears when the PR merges or closes", async () => {
  const f = fixture();
  const before = (await repos(f.sources, "web")).version;
  f.db.setMeta(prKey("web", "settings"), record(7, "open", { workers: 3 }));
  const pending = await repos(f.sources, "web");
  expect(pending.version).not.toBe(before);
  expect(pending.repo!.limits.pending).not.toBeNull();
  // The poll drops the record when the PR merges or closes; an open page sees it without a reload.
  f.db.delMeta(prKey("web", "settings"));
  const after = await repos(f.sources, "web");
  expect(after.repo!.limits.pending).toBeNull();
  expect(after.version).not.toBe(pending.version);
});

test("ui: an invalid TOWERCAB.md shows its reason", async () => {
  const f = fixture();
  f.db.setMeta(errorKey("web"), "workers: 20 isn't a whole number from 1 to 16");
  const want = "TOWERCAB.md in web can't be read: workers: 20 isn't a whole number from 1 to 16";
  const page = await repos(f.sources, "web");
  expect(page.repo!.limits.fileError).toBe(want);
  expect(page.repo!.limits.fileUrl).toMatch(/\/blob\/.+\/TOWERCAB\.md$/);
  expect((await repos(f.sources, null)).all.find((s) => s.repo === "web")!.fileError).toBe(want);
  expect((await board(f.sources)).repos.find((r) => r.repo === "web")!.fileError).toBe(want);
});

test("ui: the notice goes when the file is valid", async () => {
  const f = fixture();
  f.db.setMeta(errorKey("web"), "workers: 20 isn't a whole number from 1 to 16");
  f.db.delMeta(errorKey("web"));
  expect((await limitsOf(f)).fileError).toBeNull();
  expect((await repos(f.sources, null)).all.find((s) => s.repo === "web")!.fileError).toBeUndefined();
  expect((await board(f.sources)).repos.find((r) => r.repo === "web")!.fileError).toBeUndefined();
});

test("ui: the move PR shows on the repo page", async () => {
  const f = fixture();
  const github = f.sources.config.repos.get("web")!.github;
  f.db.setMeta(prKey("web", "move"), record(9, "open", { workers: 3 }));
  expect((await limitsOf(f)).move).toEqual({
    state: "open",
    pr: 9,
    url: `https://github.com/${github}/pull/9`,
    canOpen: false,
  });
  // Once merged and marked moved, nothing about the move is shown.
  f.db.setMeta(movedKey("web"), String(NOW));
  expect((await limitsOf(f)).move).toMatchObject({ state: "moved", pr: null, url: null, canOpen: false });
});

test("ui: a closed move PR offers to open it again", async () => {
  const f = fixture();
  f.db.setMeta(prKey("web", "move"), record(9, "closed", { workers: 3 }));
  expect((await limitsOf(f)).move).toMatchObject({ state: "closed", pr: 9, canOpen: true });
  // A page that can't act (no loop) doesn't offer it.
  f.state.running = false;
  expect((await limitsOf(f)).move.canOpen).toBe(false);
  expect((await limitsOf(f)).canSave).toBe(false);
});

test("ui: the page says how long until the automatic move", async () => {
  const f = fixture();
  expect((await limitsOf(f)).waitHours).toBe(24);
  f.db.setMeta(PARSER_KEY, `abc ${NOW - 3600}`);
  expect((await limitsOf(f)).waitHours).toBe(23);
  f.db.setMeta(PARSER_KEY, `abc ${NOW - 25 * 3600}`);
  expect((await limitsOf(f)).waitHours).toBeNull();
  // The same page over HTTP.
  const ui = startUi({ port: 0, sources: f.sources, actions: f.actions, distDir: tempDir(), log: () => {} });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const page = JSON.parse((await call(port, { path: "/api/repos?repo=web" })).body);
  expect(page.repo.limits.waitHours).toBeNull();
});
