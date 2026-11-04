// A git checkout standing for Towercab's own code (LOOP-105): tests move it to a newer commit the way a
// self-update or a manual `git pull` does.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, tempDir } from "./world.ts";

/** A checkout with one commit. */
export function codeCheckout(): string {
  const dir = tempDir("tc-code-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.ts"), "1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

export const headOf = (dir: string): string => git(dir, "rev-parse", "HEAD").trim();

/** The checkout moves to a newer commit; returns it. */
export function moveOn(dir: string): string {
  writeFileSync(join(dir, "a.ts"), `${Math.random()}\n`);
  git(dir, "commit", "-q", "-am", "newer");
  return headOf(dir);
}
