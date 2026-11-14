// The new intent actions behind the form (UI-216, UI-217): checkIntent and createIntent over a real intents
// store, a fake `claude` and a real server, with the role of the person chosen by the test.

import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openStore } from "../../src/intents/store.ts";
import { createActions } from "../../src/ui/actions.ts";
import { type Role, startUi } from "../../src/ui/server.ts";
import { buildFixture } from "../../ui/fixture.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { overlapChild } from "../helpers/overlap-claude.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, tempDir } from "../helpers/world.ts";
import { intentMd } from "../intents/fixtures.ts";
import { ObsRig } from "../observer/rig.ts";
import { call, post } from "./http.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const body = "\n## Problem\n\nNo greeting.\n";
const GREET = "261021-0900";
const BUILT = "261021-0901";
const TITLE = "Web shows a hello form on the page";

async function rig(role: { now: Role } = { now: "maintainer" }) {
  const f = buildFixture({ empty: true });
  cleanup.push(() => f.cleanup());
  const remote = bareRepo({
    [`intents/${GREET}-greet/intent.md`]: `${intentMd("web", "u: 3\nsource: me\n", "Web greets visitors")}${body}`,
    [`intents/${BUILT}-built/intent.md`]: `${intentMd("web", "u: 3\nsource: me\nstage: code\n", "Web has a login page")}${body}`,
  });
  const store = await openStore({
    remote,
    path: join(tempDir(), "intents"),
    tools: new FakeTools(),
    log: () => {},
  });
  const tools = new FakeTools();
  const obs = new ObsRig();
  const github = fakeGitHub(obs.tools);
  const intentStore = Object.assign(Object.create(store) as typeof store, { github: () => "owner/intents" });
  const actions = createActions({
    db: f.db,
    store: intentStore,
    config: f.sources.config,
    clock: f.sources.clock,
    github: { owner: async () => ({ ok: true, stdout: "", stderr: "" }) } as never,
    intentTools: {
      home: f.home,
      tools,
      userHome: "/home/owner",
      towercabExe: "/bin/towercab",
      proposal: { config: obs.config, home: obs.home, tools: obs.tools, github, who: "ben" },
    },
  });
  const ui = startUi({
    port: 0,
    sources: { ...f.sources, store: intentStore },
    actions,
    distDir: tempDir("tc-dist-"),
    log: () => {},
    roleOf: () => role.now,
    who: () => "Ana via page",
  });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  const send = async (b: Record<string, unknown>) => {
    const r = await post(port, ui.token, b);
    return { status: r.status, ...(JSON.parse(r.body) as Record<string, unknown>) } as {
      status: number;
      ok: boolean;
      message: string;
      [k: string]: unknown;
    };
  };
  const files = () =>
    git(remote, "ls-tree", "-r", "--name-only", "main")
      .split("\n")
      .filter((p) => p.endsWith("intent.md"));
  return { f, remote, port, tools, obs, send, files, role, intentStore };
}

const draft = (over: Record<string, unknown> = {}) => ({ repo: "web", title: TITLE, ...over });

test("ui: checkIntent returns matches", async () => {
  const r = await rig();
  r.tools.child(
    "claude",
    overlapChild({
      matches: [
        { kind: "open", ref: GREET, how: "Both show a hello to visitors" },
        { kind: "open", ref: BUILT, how: "Both touch the first screen" },
      ],
      title_note: "It is short",
    }),
  );
  const out = await r.send({ action: "checkIntent", ...draft() });
  expect(out).toMatchObject({ status: 200, ok: true, titleNote: "It is short" });
  expect(out.matches).toEqual([
    {
      kind: "open",
      ref: GREET,
      title: "Web greets visitors",
      how: "Both show a hello to visitors",
      canAdd: true,
      pastDesign: false,
    },
    {
      kind: "open",
      ref: BUILT,
      title: "Web has a login page",
      how: "Both touch the first screen",
      canAdd: false,
      pastDesign: true,
    },
  ]);
  expect(r.files()).toHaveLength(2);
});

test("ui: createIntent writes the intent and returns its id", async () => {
  const r = await rig();
  const out = await r.send({ action: "createIntent", ...draft({ u: 4, problem: "Nothing helps." }) });
  expect(out).toMatchObject({ status: 200, ok: true, added: false });
  expect(out.id).toMatch(/^\d{6}-\d{4}$/);
  expect(out.message).toBe(`Created ${out.id}.`);
  expect(r.files()).toContain(out.path);
  const text = git(r.remote, "show", `main:${out.path}`);
  expect(text).toContain("repo: web\nu: 4\nsource: me\n");
  expect(text).toContain("## Problem\n\nNothing helps.");
  // The check is not run by `createIntent`: the form decides after `checkIntent` (UI-216).
  expect(r.tools.spawned).toEqual([]);
});

test("ui: the page does not open on a missing intent", async () => {
  const r = await rig();
  const out = await r.send({ action: "createIntent", ...draft() });
  const page = await call(r.port, {
    path: `/api/intents/${out.id}`,
    headers: { Accept: "application/json" },
  });
  expect(page.status).toBe(200);
  expect(JSON.parse(page.body)).toMatchObject({ id: out.id, title: TITLE });
});

test("ui: createIntent with addTo appends to the intent", async () => {
  const r = await rig();
  const out = await r.send({
    action: "createIntent",
    ...draft({ constraints: "Keep it small" }),
    addTo: GREET,
  });
  expect(out).toMatchObject({ status: 200, ok: true, added: true, id: GREET, message: `Added to ${GREET}.` });
  expect(r.files()).toHaveLength(2);
  const text = git(r.remote, "show", `main:intents/${GREET}-greet/intent.md`);
  expect(text).toContain("## Constraints\n\nKeep it small");
  expect(text).toContain("# Intent: Web greets visitors\n");
  expect(git(r.remote, "log", "--format=%B", "-1", "main")).toContain("Added-by: Ana via page");
});

test("ui: createIntent refuses a bad value and writes nothing", async () => {
  const r = await rig();
  const head = git(r.remote, "rev-parse", "main");
  for (const bad of [
    { repo: "nowhere" },
    { title: "" },
    { title: "two\nlines" },
    { u: 9 },
    { i: "3" },
    { a: 6 },
    { problem: "x".repeat(20_001) },
  ]) {
    const out = await r.send({ action: "createIntent", ...draft(bad) });
    expect(out.status, JSON.stringify(bad)).toBe(422);
    expect(out.ok).toBe(false);
  }
  expect(git(r.remote, "rev-parse", "main")).toBe(head);
  // A bad value is refused before the check is paid for.
  const check = await r.send({ action: "checkIntent", ...draft({ repo: "nowhere" }) });
  expect(check).toMatchObject({ status: 422, ok: false });
  expect(r.tools.spawned).toEqual([]);
});

test("ui: createIntent refuses addTo for an intent past design", async () => {
  const r = await rig();
  const head = git(r.remote, "rev-parse", "main");
  const out = await r.send({ action: "createIntent", ...draft(), addTo: BUILT });
  expect(out).toMatchObject({ status: 422, ok: false });
  expect(out.message).toBe(
    `${BUILT} is already past design, so new text would not change it. Write a new intent instead and link ${BUILT} in it.`,
  );
  expect(git(r.remote, "rev-parse", "main")).toBe(head);
});

test("ui: a contributor's createIntent opens a proposal", async () => {
  const r = await rig({ now: "contributor" });
  const out = await r.send({ action: "createIntent", ...draft({ a: 3 }) });
  expect(out).toMatchObject({ status: 200, ok: true, proposal: true, added: false, path: "", pr: 7 });
  expect(out.message).toBe(`Proposed ${out.id}. A maintainer will accept or close it.`);
  expect(out.url).toBe("https://github.com/owner/intents/pull/7");
  // Nothing reached main.
  expect(r.files()).toHaveLength(2);
  expect(r.obs.created).toHaveLength(1);
});

test("ui: the mode follows the role, not the request", async () => {
  const r = await rig({ now: "contributor" });
  // A request that says it is direct, or a maintainer, is still a proposal.
  const out = await r.send({
    action: "createIntent",
    ...draft(),
    mode: "direct",
    role: "maintainer",
    actor: "owner",
  });
  expect(out).toMatchObject({ ok: true, proposal: true });
  expect(r.files()).toHaveLength(2);
  r.role.now = "maintainer";
  const direct = await r.send({
    action: "createIntent",
    ...draft({ title: `${TITLE} again` }),
    mode: "proposal",
  });
  expect(direct).toMatchObject({ ok: true, added: false });
  expect(direct.proposal).toBeUndefined();
  expect(r.files()).toHaveLength(3);
});

test("ui: addTo needs the maintainer role", async () => {
  const r = await rig({ now: "contributor" });
  const out = await r.send({ action: "createIntent", ...draft(), addTo: GREET });
  expect(out).toMatchObject({
    status: 403,
    ok: false,
    message: "Needs maintainer on web (you are contributor)",
  });
  expect(git(r.remote, "show", `main:intents/${GREET}-greet/intent.md`)).not.toContain("hello form");
  // The check never offers an add to a contributor.
  r.tools.child(
    "claude",
    overlapChild({ matches: [{ kind: "open", ref: GREET, how: "Both show a hello" }] }),
  );
  const check = await r.send({ action: "checkIntent", ...draft() });
  expect((check.matches as { canAdd: boolean }[])[0]!.canAdd).toBe(false);
});

test("ui: the new intent actions need the contributor role", async () => {
  const r = await rig({ now: "viewer" });
  for (const action of ["checkIntent", "createIntent"]) {
    const out = await r.send({ action, ...draft() });
    expect(out).toMatchObject({
      status: 403,
      ok: false,
      message: "Needs contributor on web (you are viewer)",
    });
  }
  expect(r.tools.spawned).toEqual([]);
  expect(r.files()).toHaveLength(2);
});

test("ui: a repeated create is refused as already created", async () => {
  const r = await rig();
  const first = await r.send({ action: "createIntent", ...draft() });
  expect(first.ok).toBe(true);
  const again = await r.send({ action: "createIntent", ...draft() });
  expect(again).toMatchObject({ status: 422, ok: false, message: `Already created as ${first.id}` });
  expect(r.files()).toHaveLength(3);
  // Another title is another intent.
  const other = await r.send({ action: "createIntent", ...draft({ title: `${TITLE} too` }) });
  expect(other.ok).toBe(true);
});
