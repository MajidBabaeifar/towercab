// Every live spec row's `Verified by` tests exist (specs/README.md).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

interface Row {
  file: string;
  id: string;
  tests: string[];
  removed: boolean;
}

function rows(file: string): Row[] {
  const out: Row[] = [];
  const parts = readFileSync(file, "utf8").split(/^### /m).slice(1);
  for (const p of parts) {
    const id = p.split(" ")[0]!;
    const verified = /Verified by:([\s\S]*?)(?:\n\n|\n### |$)/.exec(p)?.[1] ?? "";
    const tests = [...verified.split(/\bmanual\b/)[0]!.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1]!)
      .filter((t) => !t.startsWith("manual"));
    out.push({ file, id, tests, removed: /\n\s*Removed/.test(p.split("\n").slice(0, 3).join("\n")) });
  }
  return out;
}

/** `Live: A-1..3, B-4` → a predicate over IDs; bare `Live` → all; `Draft`/`Removed` → none. */
function liveSet(file: string): (id: string) => boolean {
  const status = /\*\*Status:\*\*\s*([^·\n]*)/.exec(readFileSync(file, "utf8"))?.[1]?.trim() ?? "";
  if (status === "Live") return () => true;
  if (!status.startsWith("Live:")) return () => false;
  const ranges = status
    .slice(5)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^([A-Z]+)-(\d+)(?:\.\.(\d+))?$/.exec(s);
      if (!m) throw new Error(`${file}: bad Live entry ${s}`);
      return { prefix: m[1]!, lo: Number(m[2]), hi: Number(m[3] ?? m[2]) };
    });
  return (id) => {
    const [p, n] = [id.split("-")[0], Number(id.split("-")[1])];
    return ranges.some((r) => r.prefix === p && n >= r.lo && n <= r.hi);
  };
}

function testTitles(dir: string): Set<string> {
  const titles = new Set<string>();
  if (!existsSync(dir)) return titles;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(test|spec)\.tsx?$/.test(f)) {
        for (const m of readFileSync(p, "utf8").matchAll(/\b(?:test|it)\(\s*"([^"]+)"/g)) titles.add(m[1]!);
      }
    }
  };
  walk(dir);
  return titles;
}

test("specs: every live row names tests that exist", () => {
  const titles = new Set([...testTitles("tests"), ...testTitles("ui")]);
  const missing: string[] = [];
  for (const f of readdirSync("specs").filter(
    (f) => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md",
  )) {
    const file = join("specs", f);
    const live = liveSet(file);
    for (const r of rows(file)) {
      if (r.removed || !live(r.id)) continue;
      for (const t of r.tests) if (!titles.has(t)) missing.push(`${r.id}: ${t}`);
    }
  }
  expect(missing).toEqual([]);
});
