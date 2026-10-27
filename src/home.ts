// The home folder (LOOP-1): database, lock, log, intents checkout, clones, checkouts, run files, caches.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { expand } from "./config.ts";

export class Home {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** `--home` > `TOWERCAB_HOME` > `~/.local/share/towercab`, created 0700. */
  static resolve(flag?: string): Home {
    const root = expand(flag ?? process.env.TOWERCAB_HOME ?? "~/.local/share/towercab");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return new Home(root);
  }

  get db(): string {
    return join(this.root, "towercab.db");
  }
  get lockPath(): string {
    return join(this.root, "towercab.lock");
  }
  get logFile(): string {
    return join(this.root, "towercab.log");
  }
  get intents(): string {
    return join(this.root, "intents");
  }
  repo(name: string): string {
    return join(this.root, "repos", name);
  }
  /** A mission's checkout, relative to the home as stored in `missions.checkout`. */
  workRel(id: string, attempt: number): string {
    return join("work", `${id}-${attempt}`);
  }
  abs(rel: string): string {
    return join(this.root, rel);
  }
  runs(id: string): string {
    const d = join(this.root, "runs", id);
    mkdirSync(d, { recursive: true });
    return d;
  }
  cache(repo: string): string {
    const d = join(this.root, "cache", repo);
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** The pid holding the loop lock, if that process is alive. */
  holder(): number | null {
    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(this.lockPath, "utf8").trim(), 10);
    } catch {
      return null;
    }
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  }

  /** Take the loop lock (one loop per home, LOOP-15); a dead holder's lock is taken over. */
  lock(): LoopLock {
    for (let i = 0; i < 2; i++) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        writeSync(fd, `${process.pid}\n`);
        closeSync(fd);
        return new LoopLock(this.lockPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = this.holder();
        if (pid !== null && pid !== process.pid) {
          throw new Error(`towercab is running (pid ${pid}): towercab down first`);
        }
        rmSync(this.lockPath, { force: true });
      }
    }
    throw new Error(`can't take ${this.lockPath}`);
  }
}

export class LoopLock {
  private path: string;
  constructor(path: string) {
    this.path = path;
  }
  release(): void {
    rmSync(this.path, { force: true });
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
