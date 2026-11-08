// The evidence the observer reads (OBV-3).

import { expect, test } from "vitest";
import { buildBundle } from "../../src/observer/bundle.ts";
import { listing } from "../intents/fixtures.ts";
import { ObsRig } from "./rig.ts";

const DAY = 86_400;

function bundleOf(r: ObsRig) {
  return buildBundle({
    db: r.db,
    config: r.config,
    home: r.home,
    now: r.clock.now(),
    listing: listing([]),
    proposed: [],
    intentsRepo: "owner/intents",
  });
}

test("observer: the bundle covers fourteen days", () => {
  const r = new ObsRig();
  const now = r.clock.now();
  r.mission("old-1", "web", { updated: now - 20 * DAY, created: now - 21 * DAY });
  r.mission("new-1", "web", { updated: now - 2 * DAY, created: now - 3 * DAY });
  const b = bundleOf(r);
  expect(b.text).toContain("new-1");
  expect(b.text).not.toContain("old-1");
  expect(b.ids.has("new-1")).toBe(true);
  expect(b.ids.has("old-1")).toBe(false);
});

test("observer: the bundle names what it cut", () => {
  const r = new ObsRig({ bundle_kb: 10 });
  for (let n = 0; n < 150; n++)
    r.mission(`m-${n}`, "web", { why: `a long reason that fills the page ${"x".repeat(150)}`, repairs: 1 });
  const b = bundleOf(r);
  expect(b.cut.length).toBeGreaterThan(0);
  expect(b.text).toContain("Cut by the size limit");
  expect(b.text).toContain(b.cut[0]!);
  expect(b.text.length).toBeLessThan(12_000);
});

test("observer: secrets are removed from the bundle", () => {
  const r = new ObsRig(
    {},
    { telegram: { bot_token: "123456:SECRET-bot-token-value", chat_id: 42 } },
  );
  r.mission("leaky", "web", { why: "the log said 123456:SECRET-bot-token-value in a URL" });
  const b = bundleOf(r);
  expect(b.text).toContain("leaky");
  expect(b.text).not.toContain("SECRET-bot-token-value");
});

test("observer: every item has an id to cite", () => {
  const r = new ObsRig();
  r.mission("with-pr", "web", { pr: 5, spec_pr: 3, plan_pr: 4 });
  const b = bundleOf(r);
  for (const id of ["i-1", "i-2", "with-pr", "owner/web#5", "owner/web#3", "owner/intents#4"]) {
    expect(b.ids.has(id), id).toBe(true);
    expect(b.text, id).toContain(id);
  }
});
