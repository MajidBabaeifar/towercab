// The commit a checkout is at (LOOP-105), read from `.git` without starting a process, so the loop can
// ask on every pass and before every run.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

/** The git directory of a checkout: `.git`, or the folder a `.git` file (a worktree) points to. */
function gitDir(checkout: string): string | null {
  const dot = join(checkout, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(read(dot) ?? "");
  if (!m) return null;
  return isAbsolute(m[1]!) ? m[1]! : resolve(checkout, m[1]!);
}

/** The full commit `HEAD` names (a detached HEAD, a loose ref or a packed one), or null when unknown. */
export function readHead(checkout: string): string | null {
  const dir = gitDir(checkout);
  if (!dir) return null;
  const head = read(join(dir, "HEAD"));
  if (!head) return null;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
  // A worktree keeps its refs in the common directory.
  const common = read(join(dir, "commondir"));
  const dirs = [dir, ...(common ? [resolve(dir, common)] : [])];
  for (const d of dirs) {
    const loose = read(join(d, ref));
    if (loose && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  }
  for (const d of dirs) {
    const packed = join(d, "packed-refs");
    if (!existsSync(packed)) continue;
    for (const line of (read(packed) ?? "").split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
  }
  return null;
}
