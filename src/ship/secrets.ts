// The e2e secrets (SHIP-2): `<config dir>/secrets/<repo>.env`, private to the owner, passed only to the
// suites' and the adapter's environment and redacted from every log Towercab keeps.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Secrets {
  env: Record<string, string>;
  /** The text with every value of 4+ characters replaced by `[redacted]`. */
  redact(text: string): string;
}

export const REDACTED = "[redacted]";

export function secretsPath(configFile: string, repo: string): string {
  return join(dirname(configFile), "secrets", `${repo}.env`);
}

/** Reads the file; none → no secrets. Group or other permission bits → an Error naming the fix. */
export function readSecrets(path: string): Secrets {
  if (!existsSync(path)) return secretsOf({});
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} is readable by others; chmod 600 it`);
  const env: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const eq = l.indexOf("=");
    if (eq <= 0) throw new Error(`${path}: a line is not KEY=VALUE`);
    const key = l.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${path}: bad key ${key}`);
    let value = l.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0])
      value = value.slice(1, -1);
    env[key] = value;
  }
  return secretsOf(env);
}

export function secretsOf(env: Record<string, string>): Secrets {
  // Longest first, so a value containing another is replaced whole.
  const values = [...new Set(Object.values(env))]
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length);
  return {
    env,
    redact(text: string) {
      let out = text;
      for (const v of values) out = out.split(v).join(REDACTED);
      return out;
    },
  };
}
