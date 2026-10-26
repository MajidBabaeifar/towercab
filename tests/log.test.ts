// Log lines (LOOP-21): one readable line to stderr, the whole text in towercab.log, every move logged.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Handler, Handlers } from "../src/handlers.ts";
import * as log from "../src/log.ts";
import { ORDER, ok, wait } from "../src/machine.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { tempDir } from "./helpers/world.ts";

let out: string[] = [];
function capture() {
  out = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
}

afterEach(() => {
  log.init(null);
  vi.restoreAllMocks();
});

test("log: one line", () => {
  capture();
  // The first meaningful line, control characters as spaces, and how many lines were cut.
  log.emit("\n\n  first\tline\u0007 here  \nsecond\n\nthird\n");
  expect(out).toEqual(["towercab: first line  here (+2 lines)\n"]);
  // `Usage:` and `Flags:` lines aren't meaningful.
  expect(log.line("Usage: gh pr view\nFlags:\nreal error").line).toBe("real error");
  // At most 300 characters.
  const long = log.emit("x".repeat(400));
  expect(long).toHaveLength(300);
  expect(long.endsWith("…")).toBe(true);
  // A warning repeating every pass is logged once until it changes.
  out = [];
  log.warn("telegram", "telegram: can't reach api.telegram.org");
  log.warn("telegram", "telegram: can't reach api.telegram.org");
  log.warn("telegram", "telegram: HTTP 502");
  log.clearWarn("telegram");
  log.warn("telegram", "telegram: HTTP 502");
  expect(out).toEqual([
    "towercab: telegram: can't reach api.telegram.org\n",
    "towercab: telegram: HTTP 502\n",
    "towercab: telegram: HTTP 502\n",
  ]);
});

test("log: full text in file", () => {
  capture();
  const file = join(tempDir("tc-log-"), "towercab.log");
  log.init(file);
  // A one-line message stays out of the file.
  log.emit("picked 261026-1000 (web): Show a greeting");
  expect(existsSync(file)).toBe(false);
  const text = "git push failed\nremote: rejected\nhint: fetch first";
  const now = new Date("2026-10-26T12:00:00Z");
  expect(log.emit(text, now)).toBe(`git push failed (+2 lines) · full: ${file}`);
  expect(readFileSync(file, "utf8")).toBe(`--- 2026-10-26T12:00:00.000Z\n${text}\n`);
  // A cut long line goes there whole too.
  log.emit("y".repeat(400), now);
  expect(readFileSync(file, "utf8")).toContain(`--- 2026-10-26T12:00:00.000Z\n${"y".repeat(400)}\n`);
  // Rotated at 5 MiB.
  writeFileSync(file, "z".repeat(log.ROTATE + 1));
  log.emit("after\nrotation", now);
  expect(statSync(`${file}.1`).size).toBe(log.ROTATE + 1);
  expect(readFileSync(file, "utf8")).toBe("--- 2026-10-26T12:00:00.000Z\nafter\nrotation\n");
});

test("log: moves are logged", async () => {
  const p = new Pipe(TARGET, { "intents/261026-1000-t/intent.md": intent({ title: "T" }) });
  const h: Handler = {
    async step(_cx, m) {
      if (m.stage === "pick") return { done: ok() };
      return { done: wait("answer the question", `Which colour?\n${"long ".repeat(40)}`) };
    },
    async finish() {
      return { done: ok() };
    },
  };
  const handlers: Handlers = Object.fromEntries(ORDER.map((s) => [s, h]));
  await p.start({}, { handlers });
  for (let i = 0; i < 3; i++) {
    await p.loop.pass();
    p.clock.advance(61);
  }
  const moves = p.logs.filter((l) => l.includes(" → "));
  expect(moves[0]).toBe("261026-1000 pick → design (ok)");
  // The reason on one line, cut to 120 characters.
  expect(moves[1]).toMatch(/^261026-1000 design → blocked \(wait: Which colour\? long long .*…\)$/);
  expect(moves[1]!.length).toBeLessThan(170);
  // Through the real log, each is one line.
  capture();
  for (const m of moves) log.emit(m);
  expect(out.every((l) => l.split("\n").length === 2)).toBe(true);
});
