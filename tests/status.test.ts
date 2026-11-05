import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { apply } from "../src/machine.ts";
import { insertMission } from "../src/mission.ts";
import { decide, nextText } from "../src/pick.ts";
import { renderStatus } from "../src/status.ts";
import { at, listing } from "./intents/fixtures.ts";

test("status: shows each section", () => {
  const db = Db.memory();
  const now = 1_793_000_000;
  const cx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  let a = db.tx(() =>
    insertMission(db, { intent: "261026-1000", slug: "a", repo: "web", model: "opus", a: 3 }, now),
  );
  a = apply(cx, a, { event: "ok" });
  apply(cx, a, { event: "wait", waiting: "approve spec" });
  let b = db.tx(() =>
    insertMission(db, { intent: "261026-1100", slug: "b", repo: "api", model: "opus", a: 3 }, now),
  );
  for (let i = 0; i < 7; i++) b = apply(cx, b, { event: "ok" });
  db.setMeta("cooldown:sonnet", JSON.stringify({ until: now + 3600 }));
  const l = listing([
    at("intents/261026-1000-log-in", "", "web", "Log in"),
    at("intents/261026-1100-rate-limits", "", "api", "Rate limits"),
  ]);
  const text = renderStatus({
    db,
    listing: l,
    listingError: null,
    running: 4242,
    version: "1.0.0",
    now,
    problems: [{ kind: "github", since: now - 1000, error: "connection refused" }],
    next: "next: nothing can run now",
    prLink: () => "https://github.com/o/web/pull/7",
    queued: new Set(),
  });
  expect(text).toContain("towercab 1.0.0 · running (pid 4242) · problems");
  expect(text).toContain(
    "waiting on you:\n- 261026-1000 web: Log in · Decide if this is the right change to build: merge the spec PR to go ahead, or comment what to change. https://github.com/o/web/pull/7",
  );
  expect(text).toContain("waiting on CI:\n- 261026-1100 api: Rate limits");
  expect(text).toContain("cooling down: sonnet until");
  expect(text).toContain("problem: github: connection refused");
  expect(text.trim().split("\n").pop()).toBe("next: nothing can run now");
});

test("status: next explains skips", () => {
  const l = listing([
    at("intents/261026-1000-log-in", "u: 5\ni: 5\n", "web", "Log in"),
    at("intents/261026-1100-unknown", "u: 4\ni: 5\n", "nope", "Unknown"),
  ]);
  const d = decide(l, {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(["web"]),
    full: new Map([["web", { working: 1, owner: 0, limit: 1, ids: ["261026-1000"] }]]),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
  });
  const text = nextText(d, l, 7);
  expect(text).toMatch(/skipped: 261026-1000 web: Log in · /);
});

test("status: ready to build and ahead limit are shown", () => {
  const db = Db.memory();
  const now = 1_793_000_000;
  const cx = { db, now, subject: () => ({ title: "t", repo: "web", link: null }) };
  const add = (id: string) =>
    db.tx(() => insertMission(db, { intent: id, slug: "x", repo: "web", model: "opus", a: 3 }, now));
  // A is building; B's plan is approved and waits for the build slot.
  let a = add("261026-1000");
  for (let i = 0; i < 3; i++) a = apply(cx, a, { event: "ok" });
  let b = add("261026-1100");
  for (let i = 0; i < 2; i++) b = apply(cx, b, { event: "ok" });
  b = apply(cx, b, { event: "wait", waiting: "approve plan" });
  db.run("UPDATE missions SET data = ? WHERE id = ?", JSON.stringify({ ready: now }), b.id);
  const l = listing([
    at("intents/261026-1000-log-in", "", "web", "Log in"),
    at("intents/261026-1100-rate-limits", "", "web", "Rate limits"),
  ]);
  const text = renderStatus({
    db,
    listing: l,
    listingError: null,
    running: 1,
    version: "1",
    now,
    problems: [],
    next: "next: nothing can run now",
    waits: ["261026-1200 web: Docs · repo has 3 intents working ahead (start 261026-1200 to go now)"],
    prLink: () => null,
    queued: new Set([b.id]),
  });
  expect(text).toContain("queued:\n- 261026-1100 web: Rate limits · ready to build, behind 261026-1000");
  expect(text).toContain(
    "waiting: 261026-1200 web: Docs · repo has 3 intents working ahead (start 261026-1200 to go now)",
  );
  expect(text).not.toContain("waiting on you");
});

const held = (working: number, owner: number, limit: number) => {
  const ids = Array.from({ length: working + owner }, (_, n) => `26102${n}-1000`);
  const l = listing([
    ...ids.map((id) => at(`intents/${id}-a`, "", "web", id)),
    at("intents/261026-2000-new", "", "web", "New"),
  ]);
  const d = decide(l, {
    cutoff: 7,
    paused: false,
    blocked: null,
    repos: new Set(["web"]),
    full: new Map([["web", { working, owner, limit, ids }]]),
    cooling: new Map(),
    active: new Set(ids),
    defaultModel: "opus",
  });
  return nextText(d, l, 7);
};

test("status: the working limit and the cap are told apart", () => {
  expect(held(3, 0, 3)).toContain(
    "skipped: 261026-2000 web: New · repo has 3 intents working ahead (start 261026-2000 to go now)",
  );
  expect(held(3, 3, 3)).toContain("repo is at the cap of 6 intents before build");
  expect(held(3, 3, 3)).not.toContain("working ahead");
  // Both rules hold at the cap: the cap text is shown.
  expect(held(6, 0, 3)).toContain("repo is at the cap of 6");
});

test("status: the cap names the intents waiting on the owner", () => {
  expect(held(1, 5, 3)).toContain(
    "skipped: 261026-2000 web: New · repo is at the cap of 6 intents before build, 1 working and 5 waiting on the owner (start 261026-2000 to go now)",
  );
});
