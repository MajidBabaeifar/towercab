// A repo's feature list (INT-37..40): the file format and its line edits, the loop keeping it in step
// with missions, and the backfill run. The real store over local bare repos, a fake `claude`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { askFeatures, featuresRun } from "../src/features.ts";
import {
  cleanSentence,
  featuresHeader,
  parseFeatures,
  removeFeature,
  replaceLive,
  setFeature,
} from "../src/intents/features.ts";
import { RefusedError } from "../src/intents/types.ts";
import { happy, ID, intent, intents, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { git } from "./helpers/world.ts";

const pipes: Pipe[] = [];
afterEach(() => {
  while (pipes.length) pipes.pop()!.cleanup();
});
function pipe(target: Record<string, string>, files: Record<string, string>): Pipe {
  const p = new Pipe(target, files);
  pipes.push(p);
  return p;
}

const OWN = `# web: what people can do

Notes the owner keeps.

- [live] Visitors can read the home page.
- [planned] People can pay by card.
* [Live]   Admins can edit the menu.
`;

test("features: lines parse with status and intent", () => {
  const text = `${OWN}- [in progress] People can say hello. <!-- intent 261026-1000 -->\n- [done] Not a status.\n`;
  expect(parseFeatures(text)).toEqual([
    { status: "live", text: "Visitors can read the home page.", intent: null },
    { status: "planned", text: "People can pay by card.", intent: null },
    { status: "live", text: "Admins can edit the menu.", intent: null },
    { status: "in progress", text: "People can say hello.", intent: "261026-1000" },
  ]);
  expect(parseFeatures(null)).toEqual([]);
  expect(featuresHeader("web")).toMatch(/^# web: what people can do\n/);
});

test("features: a picked intent gets an in-progress line, other lines stay byte-identical", () => {
  const out = setFeature(OWN, "web", { intent: ID, title: "People can say hello", status: "in progress" })!;
  expect(out).toBe(`${OWN}- [in progress] People can say hello <!-- intent ${ID} -->\n`);
  // Again: nothing to change.
  expect(setFeature(out, "web", { intent: ID, title: "x", status: "in progress" })).toBeNull();
  // A first line in a new file comes after the header, a blank line between.
  const fresh = setFeature(null, "web", { intent: ID, title: "Say hello", status: "in progress" })!;
  expect(fresh.startsWith(featuresHeader("web"))).toBe(true);
  expect(fresh.endsWith(`-->\n\n- [in progress] Say hello <!-- intent ${ID} -->\n`)).toBe(true);
});

test("features: done marks the line live, keeping the owner's wording", () => {
  const started = setFeature(OWN, "web", { intent: ID, title: "Say hello", status: "in progress" })!;
  const edited = started.replace("Say hello", "Visitors are greeted by name");
  const live = setFeature(edited, "web", { intent: ID, title: "Say hello", status: "live" })!;
  expect(live).toBe(`${OWN}- [live] Visitors are greeted by name <!-- intent ${ID} -->\n`);
  // Done without a line (picked before lists existed): one is added, live.
  expect(setFeature(OWN, "web", { intent: ID, title: "Say hello", status: "live" })).toContain(
    `- [live] Say hello <!-- intent ${ID} -->`,
  );
});

test("features: a dropped intent's line is removed", () => {
  const started = setFeature(OWN, "web", { intent: ID, title: "Say hello", status: "in progress" })!;
  expect(removeFeature(started, ID)).toBe(OWN);
  expect(removeFeature(OWN, ID)).toBeNull();
  expect(removeFeature(null, ID)).toBeNull();
});

test("features: the backfill replaces only the untagged live lines", () => {
  const started = setFeature(OWN, "web", { intent: ID, title: "Say hello", status: "in progress" })!;
  const out = replaceLive(started, "web", ["People can sign in.", "People can sign out."])!;
  expect(out).toBe(
    [
      "# web: what people can do",
      "",
      "Notes the owner keeps.",
      "",
      "- [live] People can sign in.",
      "- [live] People can sign out.",
      "- [planned] People can pay by card.",
      `- [in progress] Say hello <!-- intent ${ID} -->`,
      "",
    ].join("\n"),
  );
  expect(replaceLive(out, "web", ["People can sign in.", "People can sign out."])).toBeNull();
  // No file yet: the header, then the lines.
  expect(replaceLive(null, "web", ["People can sign in."])).toBe(
    `${featuresHeader("web")}\n- [live] People can sign in.\n`,
  );
});

test("features: model text is cleaned to one sentence", () => {
  expect(cleanSentence("- [live] People can\nsign in <!-- intent x -->")).toBe("People can sign in");
  expect(cleanSentence("## 1. Heading")).toBe("Heading");
  expect(cleanSentence("   ")).toBeNull();
  expect(cleanSentence("x".repeat(500))!.length).toBe(200);
});

test("intents: the feature list is written through the store", async () => {
  const p = pipe(TARGET, intents());
  await p.start({}, { handlers: {} });
  const wrote = await p.store.editFeatures("web", "backfill", (t) =>
    replaceLive(t, "web", ["People can sign in."]),
  );
  expect(wrote).toBe(true);
  expect(p.show("intents", "main", "features/web.md")).toContain("- [live] People can sign in.\n");
  expect(git(p.bares.intents!, "log", "-1", "--format=%s", "main").trim()).toBe(
    "towercab: features web backfill",
  );
  // Nothing to change: no commit.
  expect(await p.store.editFeatures("web", "again", () => null)).toBe(false);
  await expect(p.store.editFeatures("../x", "x", () => "x")).rejects.toThrow(RefusedError);
});

test("features: the loop tracks an intent from pick to done", async () => {
  const p = pipe(TARGET, intents(intent({ a: 5, title: "Visitors are greeted on the home page" })));
  happy(p);
  await p.start();
  await p.untilStage("design");
  const line = `<!-- intent ${ID} -->`;
  expect(p.show("intents", "main", "features/web.md")).toContain(
    `- [in progress] Visitors are greeted on the home page ${line}`,
  );
  await p.untilStage("done");
  const file = p.show("intents", "main", "features/web.md");
  expect(file).toContain(`- [live] Visitors are greeted on the home page ${line}`);
  expect(file).not.toMatch(/^- \[in progress\]/m);
});

test("features: a dropped intent's line goes", async () => {
  const p = pipe(TARGET, intents(intent({ a: 1 })));
  happy(p);
  await p.start();
  await p.untilStage("approval:spec");
  expect(p.show("intents", "main", "features/web.md")).toContain(`<!-- intent ${ID} -->`);
  p.db.run("INSERT INTO commands (name, arg, text, source, created) VALUES ('drop', ?, '', 'ui', 0)", ID);
  await p.untilStage("stopped");
  expect(p.show("intents", "main", "features/web.md")).not.toContain(ID);
});

const README = "# Web\n\nA tiny shop: browse, pay, get a receipt.\n";

test("features: the backfill reads the repo read-only and writes the live lines", async () => {
  const p = pipe({ ...TARGET, "README.md": README }, intents());
  await p.start({}, { handlers: {} });
  let seen = "";
  p.queue("features", (spec) => {
    seen = readFileSync(join(spec.cwd, "README.md"), "utf8");
    return {
      structured: {
        features: [
          "Visitors can browse the shop.",
          "- People can pay by card.",
          "Visitors can browse the shop.",
        ],
      },
      cost: 0.3,
    };
  });
  askFeatures(p.db, "web", p.clock.now());
  await p.loop.pass();
  await p.loop.featuresIdle();
  const c = p.claudeCalls.find((x) => x.kind === "features")!;
  expect(seen).toBe(README);
  expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
  expect(c.argv).toContain("--json-schema");
  expect(c.settings).toMatchObject({ sandbox: { enabled: true } });
  expect(c.prompt).toContain("<current>\n(none yet)\n</current>");
  expect(p.show("intents", "main", "features/web.md")).toContain(
    "- [live] Visitors can browse the shop.\n- [live] People can pay by card.\n",
  );
  expect(featuresRun(p.db, "web")).toMatchObject({ state: "done", n: 2, cost: 0.3 });
  // The checkout it read is gone.
  expect(existsSync(p.home.abs("work/features-web"))).toBe(false);
});

test("features: a bad backfill answer is recorded, not written", async () => {
  const p = pipe(TARGET, intents());
  await p.start({}, { handlers: {} });
  p.queue("features", () => ({ structured: { features: "not a list" } }));
  askFeatures(p.db, "web", p.clock.now());
  await p.loop.pass();
  await p.loop.featuresIdle();
  const r = featuresRun(p.db, "web")!;
  expect(r.state).toBe("failed");
  expect(r.why).toContain("doesn't fit the schema");
  expect(() => p.show("intents", "main", "features/web.md")).toThrow();
  // Asked again, it runs again.
  p.queue("features", () => ({ structured: { features: ["People can say hello."] } }));
  askFeatures(p.db, "web", p.clock.now());
  await p.loop.pass();
  await p.loop.featuresIdle();
  expect(featuresRun(p.db, "web")!.state).toBe("done");
});
