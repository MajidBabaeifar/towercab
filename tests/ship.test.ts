// Ship stage units (SHIP-2, SHIP-3, SHIP-14): the secrets file, the adapters' shape, the repo hold.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Ctx } from "../src/handlers.ts";
import { getMission, insertMission, type Mission } from "../src/mission.ts";
import { holder } from "../src/pipeline/ship.ts";
import { adapterOf } from "../src/ship/adapter.ts";
import { parseLive } from "../src/ship/live.ts";
import { readSecrets, secretsOf, secretsPath } from "../src/ship/secrets.ts";
import { tempDir, testDb } from "./helpers/world.ts";

test("ship: secrets file must be private", () => {
  const d = tempDir();
  const f = join(d, "web.env");
  expect(readSecrets(f).env).toEqual({});
  writeFileSync(f, "# a test login\nE2E_USER=tester\nE2E_PASS='p a s s'\n\n");
  chmodSync(f, 0o644);
  expect(() => readSecrets(f)).toThrow(`${f} is readable by others; chmod 600 it`);
  chmodSync(f, 0o600);
  expect(readSecrets(f).env).toEqual({ E2E_USER: "tester", E2E_PASS: "p a s s" });
  writeFileSync(f, "not a pair\n");
  expect(() => readSecrets(f)).toThrow("a line is not KEY=VALUE");
  expect(secretsPath("/home/x/.config/towercab/config.toml", "web")).toBe(
    "/home/x/.config/towercab/secrets/web.env",
  );
});

test("ship: secrets are redacted from logs", () => {
  const s = secretsOf({ A: "tok", B: "s3cret", C: "s3cret-longer" });
  // Values under 4 characters stay (they would hide ordinary words); the longest goes first.
  expect(s.redact("tok s3cret s3cret-longer")).toBe("tok [redacted] [redacted]");
});

test("ship: adapters answer the same questions", () => {
  const live = (adapter: string) =>
    parseLive(
      new Map<string, unknown>([
        ["url", "https://a.dev"],
        ["adapter", adapter],
        ["live_command", "true"],
        ["rollback_command", "true"],
        [
          "suites",
          [
            new Map<string, unknown>([
              ["name", "s"],
              ["command", "x"],
              ["tests", ["x"]],
            ]),
          ],
        ],
      ]),
    );
  for (const kind of ["github", "gitlab", "command"]) {
    const a = adapterOf({
      cx: { repo: () => ({ github: "owner/web" }) } as unknown as Ctx,
      m: {} as Mission,
      live: live(kind),
      secrets: secretsOf({}),
      clone: "/c",
      dir: "/d",
    });
    expect(Object.keys(a).sort(), kind).toEqual(["current", "outcome", "rollback"]);
  }
});

test("ship: the gate holds while another change ships", () => {
  const db = testDb();
  const add = (intent: string, repo: string, stage: string, extra: Record<string, unknown> = {}) => {
    const m = db.tx(() => insertMission(db, { intent, slug: "x", repo, model: "opus", a: 5 }, 1));
    db.run(
      "UPDATE missions SET stage = ?, waiting = ?, data = ? WHERE id = ?",
      stage,
      (extra.waiting as string) ?? null,
      JSON.stringify(extra.data ?? {}),
      m.id,
    );
    return getMission(db, m.id)!;
  };
  const cx = { db } as unknown as Ctx;
  const me = add("261030-0001", "web", "gate");
  expect(holder(cx, me)).toBeNull();
  // Another repo shipping doesn't hold this one.
  add("261030-0002", "api", "e2e");
  expect(holder(cx, me)).toBeNull();
  const shipping = add("261030-0003", "web", "deploy");
  expect(holder(cx, me)?.intent).toBe("261030-0003");
  db.run("UPDATE missions SET stage = 'done' WHERE id = ?", shipping.id);
  expect(holder(cx, me)).toBeNull();
  // A fix round in progress, or a frozen repo, holds too; a reverted intent doesn't.
  const fixing = add("261030-0004", "web", "ci", { data: { ship: { merges: ["a"], fixes: 1 } } });
  expect(holder(cx, me)?.intent).toBe("261030-0004");
  db.run("UPDATE missions SET stage = 'stopped' WHERE id = ?", fixing.id);
  const frozen = add("261030-0005", "web", "blocked", { waiting: "rollback failed" });
  expect(holder(cx, me)?.intent).toBe("261030-0005");
  db.run("UPDATE missions SET stage = 'stopped' WHERE id = ?", frozen.id);
  add("261030-0006", "web", "blocked", {
    waiting: "rolled back, revise",
    data: { ship: { merges: ["a"], fixes: 2 } },
  });
  expect(holder(cx, me)).toBeNull();
});
