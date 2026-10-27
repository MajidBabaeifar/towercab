// Network, auth and tool failures (LOOP-10): classifying a failed call or a run's output, and the
// in-memory health of each kind (`github`, `claude`, `tool:<exe>`, `sandbox`).

/** A fault open this long (seconds) pauses picks and sends one message. */
export const BLOCK_AFTER = 900;

const AUTH =
  /\bhttp(?:\/[0-9.]+)?:? 401\b|\b401 unauthorized|status(?: code)?:? 401\b|returned error: 401\b|bad credentials|authentication failed|\/login\b|invalid api key|oauth token (?:has )?expired|remote: repository not found/i;

const NETWORK =
  /could not resolve (?:host|proxy)|name resolution|name or service not known|no address associated|connection (?:refused|reset|timed out|closed)|network is unreachable|no route to host|timed? ?out\b|tls handshake|handshake (?:failed|failure)|ssl certificate problem|certificate verify failed|ssl_(?:connect|read|write|error)|ssl routines|tls connection|ssl connection|unexpected eof|early eof|\bhttp(?:\/[0-9.]+)?:? 5[0-9]{2}\b|\b5[0-9]{2} (?:internal server error|bad gateway|service unavailable|gateway time-?out)|status(?: code)?:? 5[0-9]{2}\b|returned error: 5[0-9]{2}\b|api error: 5[0-9]{2}|error connecting|failed to connect to|could(?: not|n't) connect to server|econn(?:refused|reset)|etimedout|enotfound|eai_again|fetch failed|socket hang up/i;

/**
 * A failed call's class by its stderr (git, gh, the GitHub API, Telegram, `claude`): network (DNS,
 * refused, reset, timeout, TLS, HTTP 5xx) or auth (HTTP 401, `Bad credentials`, `/login`, git's
 * `Repository not found`: GitHub's answer to a token it won't take on a private repo); anything
 * else is the call's own failure.
 */
export function classifyFailure(stderr: string): "network" | "auth" | null {
  if (AUTH.test(stderr)) return "auth";
  if (NETWORK.test(stderr)) return "network";
  return null;
}

const MISSING =
  /(?:\bsh: \d+: ([A-Za-z0-9._+-]+): not found|\b([A-Za-z0-9._+-]+): command not found|: \d+: exec: (?:\S*\/)?([A-Za-z0-9._+-]+): not found)/;

/**
 * A broken environment in a run's output (a worker's question, a setup or checks log), not a
 * question for the owner: the sandbox not starting → `sandbox`; `sh: 1: <exe>: not found` or
 * `<exe>: command not found` → `tool:<exe>`. `why` is the matching line, at most 200 characters.
 */
export function classifyRun(text: string): { kind: string; why: string } | null {
  const sandbox = text
    .split("\n")
    .find(
      (l) =>
        l.includes("apply-seccomp") ||
        l.includes("bwrap:") ||
        (l.includes("setgroups") && l.includes("Permission denied")),
    );
  if (sandbox !== undefined) return { kind: "sandbox", why: cut(sandbox.trim(), 200) };
  const m = MISSING.exec(text);
  if (!m) return null;
  return { kind: `tool:${m[1] ?? m[2] ?? m[3]}`, why: cut(m[0], 200) };
}

/** What the owner does about a fault kind (the message's fix line). */
export function fixFor(kind: string): string {
  if (kind === "github") return "check the network and the GitHub App (ops/github-app.json, app.pem)";
  if (kind === "claude") return "run claude and /login, or check the network";
  if (kind === "sandbox")
    return "the sandbox can't start: on Ubuntu set [agent] sandbox_unix_sockets = true (towercab doctor), else check bwrap";
  if (kind.startsWith("tool:")) return `install ${kind.slice(5)} on the service's PATH`;
  return "see towercab doctor";
}

export interface OpenFault {
  kind: string;
  /** Unix seconds of the first failure. */
  since: number;
  /** The latest failure's text. */
  error: string;
}

/**
 * Health per fault kind, in memory: a kind is open from its first failure to its next success. One
 * open for 15 minutes blocks picks; each such episode gives one notice, and it ends when every
 * kind has closed.
 */
export class Health {
  private faults = new Map<string, OpenFault>();
  private episode = false;
  private noticed = false;

  /** A call of `kind` failed. */
  fail(kind: string, error: string, now: number): void {
    const f = this.faults.get(kind);
    if (f) f.error = error;
    else this.faults.set(kind, { kind, since: now, error });
  }

  /** A call of `kind` succeeded: its fault closes. */
  ok(kind: string): void {
    this.faults.delete(kind);
    if (this.faults.size === 0) {
      this.episode = false;
      this.noticed = false;
    }
  }

  /** Open faults, oldest first. */
  open(): OpenFault[] {
    return [...this.faults.values()].sort((a, b) => a.since - b.since || a.kind.localeCompare(b.kind));
  }

  /** A fault has been open for 15 minutes: picks pause. */
  blocked(now: number): boolean {
    if (this.open().some((f) => now - f.since >= BLOCK_AFTER)) this.episode = true;
    return this.episode && this.faults.size > 0;
  }

  /** The fault to send one message about, once per episode (the oldest blocking one), else null. */
  noticeDue(now: number): OpenFault | null {
    if (!this.blocked(now) || this.noticed) return null;
    this.noticed = true;
    return this.open().find((f) => now - f.since >= BLOCK_AFTER) ?? this.open()[0] ?? null;
  }
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
