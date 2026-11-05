// `Forge` for GitHub: every `gh` call and GitHub reply the stages used to handle themselves, moved here.
// `GitHubForge` also still offers the raw `gh`/`owner` calls (`GitHub`) to the code that has not moved yet.

import type {
  CheckState,
  CodeScanningAlert,
  IssueRow,
  IssueText,
  Json,
  ReleaseInfo,
  SettingsSnapshot,
} from "../forge.ts";
import {
  type Bot,
  type ChecksRead,
  type Deployment,
  type DeploymentStatus,
  type FileChange,
  type Forge,
  ForgeBadReply,
  ForgeDenied,
  type GitAuth,
  type MergeMethod,
  type MergeStatus,
  type PrBrief,
  type Result,
  type Review,
} from "../forge.ts";
import type { GitHub, Host } from "../handlers.ts";
import { check, type RunOpts } from "../tools.ts";
import { checksOf } from "./checks.ts";
import { parseAuthStatus } from "./owner.ts";
import { fetchFiles } from "./proposed.ts";
import { jsonStream } from "./prs.ts";
import { readSettings, restoreSettings } from "./settings.ts";

const MERGE_FLAG: Record<MergeMethod, string> = { squash: "--squash" };

const first = (text: string): string =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

export class GitHubForge implements Forge, GitHub {
  readonly me: string;
  private readonly raw: GitHub;

  constructor(raw: GitHub) {
    this.raw = raw;
    this.me = raw.me;
  }

  // The raw calls, for code that has not moved behind the forge.
  gh: GitHub["gh"] = (github, args, opts) => this.raw.gh(github, args, opts);
  owner: GitHub["owner"] = (args, opts) => this.raw.owner(args, opts);
  gitAuth(repo: string): Promise<GitAuth> {
    return this.raw.gitAuth(repo);
  }
  bot(): Promise<Bot> {
    return this.raw.bot();
  }

  asOwner(): Forge {
    const r = this.raw;
    return new GitHubForge({
      me: r.me,
      gh: (_repo, args, opts) => r.owner(args, opts),
      owner: r.owner,
      gitAuth: (repo) => r.gitAuth(repo),
      bot: () => r.bot(),
    });
  }

  /** A `gh` call that must work: `gh <first two args>: <why>`, the stdout. */
  private async ok(repo: string, args: string[], input?: string, what?: string): Promise<string> {
    const r = await this.raw.gh(repo, args, input === undefined ? {} : { input });
    return check(r, what ?? `gh ${args.slice(0, 2).join(" ")}`);
  }

  private async soft(repo: string, args: string[], input?: string): Promise<Result> {
    const r = await this.raw.gh(repo, args, input === undefined ? {} : { input });
    return r.code === 0 ? { ok: true, reason: "" } : { ok: false, reason: (r.stderr || r.stdout).trim() };
  }

  private async view<T>(repo: string, n: number, fields: string): Promise<T> {
    const out = await this.ok(
      repo,
      ["pr", "view", String(n), "-R", repo, "--json", fields],
      undefined,
      "gh pr view",
    );
    try {
      return JSON.parse(out) as T;
    } catch (e) {
      throw new ForgeBadReply(`gh pr view: ${(e as Error).message}`);
    }
  }

  async openPr(
    repo: string,
    o: { base: string; head: string; title: string; body: string },
  ): Promise<number | null> {
    const out = await this.ok(
      repo,
      [
        "pr",
        "create",
        "-R",
        repo,
        "--base",
        o.base,
        "--head",
        o.head,
        "--title",
        o.title,
        "--body-file",
        "-",
      ],
      o.body,
    );
    const n = Number(/\/pull\/(\d+)/.exec(out)?.[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  async openPrOn(repo: string, head: string): Promise<number | null> {
    const rows = JSON.parse(
      await this.ok(repo, ["pr", "list", "-R", repo, "--head", head, "--state", "open", "--json", "number"]),
    ) as { number: number }[];
    return rows[0]?.number ?? null;
  }

  async openPrBranches(repo: string): Promise<{ number: number; branch: string }[]> {
    const rows = JSON.parse(
      await this.ok(repo, ["pr", "list", "-R", repo, "--state", "open", "--json", "number,headRefName"]),
    ) as { number: number; headRefName: string }[];
    return rows.map((r) => ({ number: r.number, branch: r.headRefName }));
  }

  async reviews(repo: string, n: number): Promise<Review[]> {
    const v = await this.view<{ reviews?: { author?: { login?: string }; state?: string }[] }>(
      repo,
      n,
      "reviews",
    );
    return (v.reviews ?? []).map((r) => ({ author: r.author?.login ?? "", state: r.state ?? "" }));
  }

  async updatePrBody(repo: string, n: number, body: string): Promise<void> {
    await this.ok(repo, ["api", "-X", "PATCH", `repos/${repo}/pulls/${n}`, "-F", "body=@-"], body);
  }

  commentOnPr(repo: string, n: number, text: string, how: { inline?: boolean } = {}): Promise<Result> {
    return how.inline
      ? this.soft(repo, ["pr", "comment", String(n), "-R", repo, "--body", text])
      : this.soft(repo, ["pr", "comment", String(n), "-R", repo, "--body-file", "-"], text);
  }

  markReady(repo: string, n: number): Promise<Result> {
    return this.soft(repo, ["pr", "ready", String(n), "-R", repo]);
  }

  mergePr(repo: string, n: number, o: { method: MergeMethod; head?: string }): Promise<Result> {
    return this.soft(repo, [
      "pr",
      "merge",
      String(n),
      MERGE_FLAG[o.method],
      ...(o.head ? ["--match-head-commit", o.head] : []),
      "-R",
      repo,
    ]);
  }

  closePr(repo: string, n: number, comment?: string): Promise<Result> {
    return this.soft(repo, [
      "pr",
      "close",
      String(n),
      "-R",
      repo,
      ...(comment ? ["--comment", comment] : []),
    ]);
  }

  async updateBranch(repo: string, n: number, expectedHead: string): Promise<void> {
    await this.ok(repo, [
      "api",
      "-X",
      "PUT",
      `repos/${repo}/pulls/${n}/update-branch`,
      "-f",
      `expected_head_sha=${expectedHead}`,
    ]);
  }

  async mergeStatus(repo: string, n: number): Promise<MergeStatus> {
    const v = await this.view<{
      headRefOid: string;
      mergeStateStatus: string;
      state: string;
      mergeCommit: { oid: string } | null;
    }>(repo, n, "headRefOid,mergeStateStatus,state,mergeCommit");
    return {
      state: v.state === "MERGED" ? "MERGED" : v.state === "CLOSED" ? "CLOSED" : "OPEN",
      head: v.headRefOid,
      mergeState: v.mergeStateStatus,
      mergeCommit: v.mergeCommit?.oid ?? null,
    };
  }

  async prBrief(repo: string, n: number): Promise<PrBrief> {
    const r = await this.raw.gh(repo, [
      "pr",
      "view",
      String(n),
      "-R",
      repo,
      "--json",
      "state,isDraft,headRefOid,mergedAt",
    ]);
    if (r.code !== 0) throw new Error(first(r.stderr || r.stdout));
    let v: { state?: unknown; isDraft?: unknown; headRefOid?: unknown; mergedAt?: unknown };
    try {
      v = JSON.parse(r.stdout) as typeof v;
    } catch {
      throw new ForgeBadReply("no state");
    }
    return {
      state: String(v.state),
      draft: v.isDraft === true,
      head: String(v.headRefOid ?? ""),
      merged: Boolean(v.mergedAt),
    };
  }

  prFiles(repo: string, n: number): Promise<FileChange[]> {
    return fetchFiles((a) => this.raw.gh(repo, a), repo, n);
  }

  async readChecks(repo: string, n: number): Promise<ChecksRead> {
    const v = await this.view<{ headRefOid: string; mergeable: string; statusCheckRollup: unknown }>(
      repo,
      n,
      "headRefOid,mergeable,statusCheckRollup",
    );
    return { head: v.headRefOid, mergeable: v.mergeable, checks: checksOf(v.statusCheckRollup) };
  }

  async rerunFailed(repo: string, run: number): Promise<void> {
    await this.ok(repo, ["run", "rerun", String(run), "-R", repo, "--failed"]);
  }

  failedLog(repo: string, run: number): Promise<string> {
    return this.ok(repo, ["run", "view", String(run), "-R", repo, "--log-failed"]);
  }

  async codeScanningAlerts(repo: string, n: number): Promise<CodeScanningAlert[]> {
    const r = await this.raw.gh(repo, [
      "api",
      `repos/${repo}/code-scanning/alerts?ref=refs/pull/${n}/merge&state=open&per_page=100`,
    ]);
    if (r.code !== 0) {
      const why = first(r.stderr || r.stdout);
      if (/HTTP 403|Resource not accessible/i.test(r.stderr + r.stdout)) throw new ForgeDenied(why);
      throw new Error(why || "gh api code-scanning alerts failed");
    }
    let rows: unknown;
    try {
      rows = JSON.parse(r.stdout);
    } catch {
      throw new ForgeBadReply("no alerts list");
    }
    if (!Array.isArray(rows)) return [];
    return rows.map((raw) => {
      const a = (raw ?? {}) as Json;
      const loc = a.most_recent_instance?.location ?? {};
      const line = Number(loc.start_line);
      return {
        rule: String(a.rule?.id ?? ""),
        path: String(loc.path ?? ""),
        line: Number.isFinite(line) && line > 0 ? line : null,
        message: String(a.most_recent_instance?.message?.text ?? a.rule?.description ?? ""),
      };
    });
  }

  async listDeployments(repo: string, environment: string, sha?: string): Promise<Deployment[]> {
    const env = encodeURIComponent(environment);
    const rows = JSON.parse(
      await this.ok(repo, [
        "api",
        `repos/${repo}/deployments?environment=${env}&per_page=30${sha ? `&sha=${sha}` : ""}`,
      ]),
    ) as { id: number; sha: string; task: string; created_at: string; payload: unknown }[];
    return rows.map((d) => ({
      id: d.id,
      sha: d.sha,
      task: d.task,
      createdAt: d.created_at,
      payload: d.payload,
    }));
  }

  async deploymentStatus(repo: string, id: number): Promise<DeploymentStatus | null> {
    const s = JSON.parse(
      await this.ok(repo, ["api", `repos/${repo}/deployments/${id}/statuses?per_page=1`]),
    ) as { state: string; description: string | null }[];
    return s[0] ? { state: s[0].state, description: s[0].description ?? "" } : null;
  }

  async createDeployment(repo: string, body: Record<string, unknown>): Promise<number> {
    const r = await this.raw.gh(repo, ["api", "-X", "POST", `repos/${repo}/deployments`, "--input", "-"], {
      input: JSON.stringify(body),
    });
    if (r.code !== 0) {
      if (/HTTP 403|Resource not accessible/i.test(r.stderr)) throw new ForgeDenied(first(r.stderr));
      throw new Error(`gh api POST deployments: ${r.stderr.trim().split("\n")[0]}`);
    }
    return (JSON.parse(r.stdout) as { id: number }).id;
  }

  async repoInfo(repo: string): Promise<{ name: string; defaultBranch: string }> {
    const r = await this.raw.gh(repo, ["api", `repos/${repo}`, "--jq", '.full_name + " " + .default_branch']);
    if (r.code !== 0) throw new Error(first(r.stderr || r.stdout));
    const [name = "", defaultBranch = ""] = r.stdout.trim().split(/\s+/);
    return { name, defaultBranch };
  }

  async activeOwnerLogin(): Promise<string | null> {
    const r = await this.raw.owner(["auth", "status", "--hostname", "github.com"]);
    return parseAuthStatus(`${r.stdout}\n${r.stderr}`);
  }

  async readFile(repo: string, path: string, ref: string): Promise<string | null> {
    const r = await this.raw.gh(repo, [
      "api",
      `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    if (r.code === 0) return r.stdout;
    // Only "not found" means the file is absent; any other failure is an error, never "no file".
    if (/\b404\b|not found/i.test(`${r.stderr}\n${r.stdout}`)) return null;
    throw new Error(`gh api ${path}: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  async greenChecks(repo: string, branch: string): Promise<Set<string> | null> {
    const head = await this.raw.gh(repo, ["api", `repos/${repo}/commits/${branch}`, "--jq", ".sha"]);
    const sha = head.stdout.trim();
    if (head.code !== 0 || !sha) return null;
    const runs = await this.raw.gh(repo, [
      "api",
      `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
      "--paginate",
      "--jq",
      ".check_runs[] | [.name, .conclusion] | @tsv",
    ]);
    if (runs.code !== 0) return null;
    return new Set(
      runs.stdout
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => p[1]?.trim() === "success")
        .map((p) => p[0]!.trim()),
    );
  }

  readSettings(repo: string, base: string, extraBranches: string[] = []): Promise<SettingsSnapshot> {
    return readSettings(this.raw, repo, base, extraBranches);
  }

  restoreSettings(repo: string, snapshot: SettingsSnapshot): Promise<string[]> {
    return restoreSettings(this.raw, repo, snapshot);
  }

  private async json<T>(repo: string, path: string): Promise<T> {
    const r = await this.raw.gh(repo, ["api", path]);
    if (r.code !== 0) throw new Error(`gh api ${path}: ${r.stderr.trim() || `exit ${r.code}`}`);
    try {
      return JSON.parse(r.stdout) as T;
    } catch (e) {
      throw new Error(`gh api ${path}: ${(e as Error).message}`);
    }
  }

  async openPrsFrom(
    repo: string,
    branch: string,
  ): Promise<{ number: number; body: string | null; author: string; head: string }[]> {
    const owner = repo.split("/")[0]!;
    const list = await this.json<
      { number: number; body: string | null; user: { login: string }; head: { sha: string } }[]
    >(repo, `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`);
    return (Array.isArray(list) ? list : []).map((p) => ({
      number: p.number,
      body: p.body,
      author: p.user?.login ?? "",
      head: p.head.sha,
    }));
  }

  async branchHead(repo: string, branch: string): Promise<string> {
    return (await this.json<{ sha: string }>(repo, `repos/${repo}/commits/${encodeURIComponent(branch)}`))
      .sha;
  }

  async mergeBase(repo: string, a: string, b: string): Promise<string | null> {
    const c = await this.json<{ merge_base_commit?: { sha: string } }>(
      repo,
      `repos/${repo}/compare/${a}...${b}`,
    );
    return c.merge_base_commit?.sha ?? null;
  }

  async prPatches(repo: string, n: number): Promise<{ name: string; patch: string | null }[]> {
    const r = await this.raw.gh(repo, ["api", "--paginate", `repos/${repo}/pulls/${n}/files?per_page=100`]);
    if (r.code !== 0) throw new Error(`gh api pulls/${n}/files: ${r.stderr.trim() || `exit ${r.code}`}`);
    const out: { name: string; patch: string | null }[] = [];
    for (const page of jsonStream(r.stdout, "gh api files")) {
      if (!Array.isArray(page)) continue;
      for (const f of page as { filename?: string; patch?: string }[]) {
        if (typeof f.filename === "string") out.push({ name: f.filename, patch: f.patch ?? null });
      }
    }
    return out;
  }

  async commitChecks(
    repo: string,
    sha: string,
    branch: string,
  ): Promise<{ seen: Map<string, CheckState>; required: string[] }> {
    const runs = await this.json<{
      check_runs?: { name: string; status: string; conclusion: string | null }[];
    }>(repo, `repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    const statuses = await this.json<{ statuses?: { context: string; state: string }[] }>(
      repo,
      `repos/${repo}/commits/${sha}/status`,
    );
    const seen = new Map<string, CheckState>();
    for (const c of runs.check_runs ?? []) {
      const ok = c.status === "completed";
      const good = ["success", "neutral", "skipped"].includes(c.conclusion ?? "");
      seen.set(c.name, !ok ? "pending" : good ? "green" : "red");
    }
    for (const s of statuses.statuses ?? []) {
      seen.set(s.context, s.state === "success" ? "green" : s.state === "pending" ? "pending" : "red");
    }
    const req = await this.raw.gh(repo, [
      "api",
      `repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
    ]);
    let required: string[] = [];
    if (req.code === 0) {
      try {
        const v = JSON.parse(req.stdout) as { contexts?: string[]; checks?: { context: string }[] };
        required = [...new Set([...(v.contexts ?? []), ...(v.checks ?? []).map((c) => c.context)])];
      } catch {
        required = [];
      }
    }
    return { seen, required };
  }

  async listReleases(repo: string, limit: number): Promise<ReleaseInfo[]> {
    const list = await this.json<
      { tag_name: string; html_url: string; draft?: boolean; created_at?: string }[]
    >(repo, `repos/${repo}/releases?per_page=${limit}`);
    return (Array.isArray(list) ? list : []).map((r) => ({
      tag: r.tag_name,
      url: r.html_url,
      draft: r.draft === true,
      createdAt: r.created_at ?? "",
    }));
  }

  async tagContains(repo: string, sha: string, tag: string): Promise<boolean | null> {
    const c = await this.raw.gh(repo, ["api", `repos/${repo}/compare/${sha}...${encodeURIComponent(tag)}`]);
    if (c.code !== 0) return null;
    try {
      const status = (JSON.parse(c.stdout) as { status?: string }).status ?? "";
      return status === "ahead" || status === "identical";
    } catch {
      return null;
    }
  }

  async requiresStatusChecks(repo: string, branch: string): Promise<boolean | null> {
    const r = await this.raw.gh(repo, ["api", `repos/${repo}/rules/branches/${branch}`]);
    if (r.code !== 0) return null;
    try {
      const rules = JSON.parse(r.stdout) as { type?: string }[];
      return rules.some((x) => x.type === "required_status_checks");
    } catch {
      return null;
    }
  }

  async listIssues(repo: string, limit: number): Promise<IssueRow[]> {
    const rows = JSON.parse(
      await this.ok(repo, [
        "issue",
        "list",
        "-R",
        repo,
        "--state",
        "all",
        "--limit",
        String(limit),
        "--json",
        "number,url,state,author,labels",
      ]),
    ) as {
      number: number;
      url: string;
      state: string;
      author: { login?: string } | null;
      labels: { name: string }[];
    }[];
    return rows.map((r) => ({
      number: r.number,
      url: r.url,
      state: r.state,
      author: r.author?.login ?? null,
      labels: (r.labels ?? []).map((l) => l.name),
    }));
  }

  async readIssue(repo: string, n: number): Promise<IssueText> {
    const v = JSON.parse(
      await this.ok(repo, ["issue", "view", String(n), "-R", repo, "--json", "title,body,author,labels"]),
    ) as { title: string; body: string; author: { login?: string } | null; labels: { name: string }[] };
    return {
      title: v.title,
      body: v.body,
      author: v.author?.login ?? null,
      labels: (v.labels ?? []).map((l) => l.name),
    };
  }

  async commentOnIssue(repo: string, n: number, text: string): Promise<void> {
    await this.ok(repo, ["issue", "comment", String(n), "-R", repo, "--body-file", "-"], text);
  }

  async addLabel(repo: string, n: number, label: string, color: string): Promise<void> {
    await this.ok(repo, [
      "label",
      "create",
      label,
      "-R",
      repo,
      "--force",
      "--color",
      color,
      "--description",
      "Towercab",
    ]);
    await this.ok(repo, ["issue", "edit", String(n), "-R", repo, "--add-label", label]);
  }

  async removeLabels(repo: string, n: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    await this.ok(repo, [
      "issue",
      "edit",
      String(n),
      "-R",
      repo,
      ...labels.flatMap((l) => ["--remove-label", l]),
    ]);
  }

  async ownerLogins(): Promise<string[]> {
    const r = await this.raw.owner(["auth", "status"], { timeoutMs: 20_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    return [...text.matchAll(/\b(?:account|as) ([\w-]+)/gi)].map((m) => m[1]!.toLowerCase());
  }
}

/** A forge that acts through the owner's own login, from just the owner's `gh`. */
export function ownerForge(owner: GitHub["owner"], me = ""): Host {
  return new GitHubForge({
    me,
    gh: (_repo, args, opts) => owner(args, opts),
    owner,
    gitAuth: async () => ({ args: [], env: {} }),
    bot: async () => ({ login: "", id: 0, email: "" }),
  });
}

/** The same forge with every `gh` call's options passed through `limit` first (a deadline, say). */
export function limitedForge(github: GitHub, limit: (opts?: RunOpts) => RunOpts): Host {
  return new GitHubForge({
    me: github.me,
    gh: async (repo, args, opts) => github.gh(repo, args, limit(opts)),
    owner: (args, opts) => github.owner(args, opts),
    gitAuth: (repo) => github.gitAuth(repo),
    bot: () => github.bot(),
  });
}

/** The forge over raw `gh` calls; a `GitHubForge` is returned as it is. */
export function forgeOf(github: GitHub): Host {
  return github instanceof GitHubForge ? github : new GitHubForge(github);
}
