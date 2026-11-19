// The owner is told once when the GitLab token is about to expire (GL-17).

import { expect, test } from "vitest";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { queueTokenNotice } from "../../src/forge/gitlab-token.ts";
import { FakeGitLab, gitlabConfig } from "../helpers/gitlab.ts";
import { testDb } from "../helpers/world.ts";

// 2026-11-05T12:00:00Z
const NOW = Date.parse("2026-11-05T12:00:00Z") / 1000;

function world(expires: string | null) {
  const gl = new FakeGitLab();
  gl.token.expires_at = expires;
  return { gl, forge: new GitLabForge(gitlabConfig().cfg, gl.http), db: testDb() };
}

const messages = (db: ReturnType<typeof testDb>) =>
  db.all<{ key: string; text: string }>("SELECT key, text FROM outbox");

test("gitlab: the owner is told once when the token is within 14 days of expiring", async () => {
  const { forge, db } = world("2026-11-12");
  expect(await queueTokenNotice(forge, db, NOW)).toBe(true);
  expect(messages(db)).toEqual([
    {
      key: "gitlab-token:2026-11-12",
      text: "GitLab token expires in 7 days (2026-11-12): create a new one before then",
    },
  ]);
  // A later pass does not repeat it; a token with a new date can notify again.
  expect(await queueTokenNotice(forge, db, NOW + 3600)).toBe(false);
  expect(messages(db)).toHaveLength(1);
});

test("gitlab: the token notice is not repeated after a restart", async () => {
  const { forge, db } = world("2026-11-12");
  await queueTokenNotice(forge, db, NOW);
  // A new loop on the same database asks again at start.
  expect(await queueTokenNotice(new GitLabForge(gitlabConfig().cfg, forge["http"]), db, NOW + 86_400)).toBe(
    false,
  );
  expect(messages(db)).toHaveLength(1);
});

test("gitlab: a token without expiry sends no notice", async () => {
  const none = world(null);
  expect(await queueTokenNotice(none.forge, none.db, NOW)).toBe(false);
  const far = world("2027-03-01");
  expect(await queueTokenNotice(far.forge, far.db, NOW)).toBe(false);
  expect(messages(none.db)).toEqual([]);
  expect(messages(far.db)).toEqual([]);
});
