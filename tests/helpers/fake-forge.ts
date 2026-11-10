// A code host in memory, at the `Forge` interface (no `gh`): pull requests with heads, comments, reviews
// and checks, issues with labels, and deployments. Every call is recorded in `calls` as a readable line.
// Settings and release reads answer "nothing there"; a test that needs them sets the field it reads.

import type {
  Bot,
  BranchPr,
  CheckState,
  ChecksRead,
  CodeScanningAlert,
  CommitProof,
  Deployment,
  DeploymentStatus,
  FileChange,
  Forge,
  GitAuth,
  IssueRow,
  IssueText,
  MergeMethod,
  MergeStatus,
  PrBrief,
  PrState,
  ReleaseInfo,
  Result,
  Review,
  SettingsSnapshot,
} from "../../src/forge.ts";
import { ownBranch } from "../../src/github/branches.ts";
import type { ProposedCache, ProposedPr } from "../../src/github/proposed.ts";

export interface FakeForgePr {
  number: number;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  head: string;
  mergeState: string;
  mergeCommit: string | null;
  comments: string[];
  reviews: Review[];
  checks: ChecksRead["checks"];
}

export interface FakeForgeIssue extends IssueText {
  /** Who set each label, for `labelEvents` (default `someone`). */
  labeledBy?: Record<string, string>;
  repo: string;
  number: number;
  url: string;
  state: string;
  comments: string[];
}

const ok: Result = { ok: true, reason: "" };

export class FakeForge implements Forge {
  readonly me: string;
  readonly calls: string[] = [];
  readonly prs: FakeForgePr[] = [];
  readonly issues: FakeForgeIssue[] = [];
  readonly deployments: (Deployment & { repo: string; statuses: DeploymentStatus[] })[] = [];
  readonly files = new Map<string, string>();
  /** AUT-35: the logins the host reports per commit sha (author, committer); none: no account. */
  readonly commitAccounts = new Map<string, (string | null)[]>();
  /** AUT-35: what the host says about a commit when a test needs the signature too; else derived from `commitAccounts`. */
  readonly commitProofs = new Map<string, CommitProof>();
  /** Branches deleted, as `<repo> <branch>`. */
  readonly deleted: string[] = [];
  private next = 1;
  private readonly failures = new Map<string, { times: number; message: string }>();

  constructor(me = "owner") {
    this.me = me;
    // `failNext` makes a method throw before it does anything: a proxy, so subclasses are covered too.
    // biome-ignore lint/correctness/noConstructorReturn: a proxy is the one way to cover subclasses
    return new Proxy(this, {
      get: (t, k, r) => {
        const v = Reflect.get(t, k, r);
        const f = typeof k === "string" ? t.failures.get(k) : undefined;
        if (typeof v !== "function" || !f || f.times <= 0) return v;
        return async () => {
          f.times--;
          t.log(`${String(k)} failed`);
          throw new Error(f.message);
        };
      },
    });
  }

  /** The next `times` calls of `method` throw `message` (and are recorded as `<method> failed`). */
  failNext(method: keyof Forge, times = 1, message = `${String(method)} failed`): void {
    this.failures.set(String(method), { times, message });
  }

  protected log(line: string): void {
    this.calls.push(line);
  }

  protected pr(repo: string, n: number): FakeForgePr {
    const p = this.prs.find((x) => x.repo === repo && x.number === n);
    if (!p) throw new Error(`no PR ${repo}#${n}`);
    return p;
  }

  async bot(): Promise<Bot> {
    return { login: "towercab[bot]", id: 9, email: "9+towercab[bot]@users.noreply.github.com" };
  }
  async gitAuth(): Promise<GitAuth> {
    return { args: [], env: {} };
  }
  asOwner(): Forge {
    return this;
  }

  async commitLogins(repo: string, sha: string): Promise<(string | null)[]> {
    this.log(`commit ${repo} ${sha}`);
    return this.commitAccounts.get(sha) ?? [null, null];
  }

  async commitProof(repo: string, sha: string): Promise<CommitProof> {
    const given = this.commitProofs.get(sha);
    if (given) return given;
    // Derived: the author is the first account and, with no committer named, the host's web committer
    // signed it (what a commit made on the host's page looks like).
    const [author, committer] = await this.commitLogins(repo, sha);
    return { author: author ?? null, committer: committer ?? "web-flow", verified: true };
  }

  async openPr(repo: string, o: { base: string; head: string; title: string; body: string }) {
    if (this.prs.some((p) => p.repo === repo && p.branch === o.head && p.state === "OPEN"))
      throw new Error(`gh pr create: a pull request for branch "${o.head}" already exists`);
    const n = this.next++;
    this.prs.push({
      number: n,
      repo,
      branch: o.head,
      base: o.base,
      title: o.title,
      body: o.body,
      state: "OPEN",
      draft: false,
      head: `sha-${n}`,
      mergeState: "CLEAN",
      mergeCommit: null,
      comments: [],
      reviews: [],
      checks: [],
    });
    this.log(`open ${repo}#${n} ${o.head}`);
    return n;
  }
  async openPrOn(repo: string, head: string) {
    return this.prs.find((p) => p.repo === repo && p.branch === head && p.state === "OPEN")?.number ?? null;
  }
  async openPrBranches(repo: string) {
    return this.prs
      .filter((p) => p.repo === repo && p.state === "OPEN")
      .map((p) => ({ number: p.number, branch: p.branch }));
  }
  async mergedPrBranches(repo: string) {
    return this.prs
      .filter((p) => p.repo === repo && p.state === "MERGED")
      .map((p) => ({ number: p.number, branch: p.branch, mergeCommit: p.mergeCommit }));
  }
  async reviews(repo: string, n: number) {
    return this.pr(repo, n).reviews;
  }
  async updatePrBody(repo: string, n: number, body: string) {
    this.pr(repo, n).body = body;
    this.log(`body ${repo}#${n}`);
  }
  async commentOnPr(repo: string, n: number, text: string): Promise<Result> {
    this.pr(repo, n).comments.push(text);
    this.log(`comment ${repo}#${n}`);
    return ok;
  }
  async markReady(repo: string, n: number): Promise<Result> {
    this.pr(repo, n).draft = false;
    this.log(`ready ${repo}#${n}`);
    return ok;
  }
  async mergePr(repo: string, n: number, o: { method: MergeMethod; head?: string }): Promise<Result> {
    const p = this.pr(repo, n);
    this.log(`merge ${repo}#${n} ${o.method}${o.head ? ` head=${o.head}` : ""}`);
    if (p.state !== "OPEN") return { ok: false, reason: `Pull request #${n} was already merged or closed` };
    if (o.head && o.head !== p.head)
      return { ok: false, reason: "Head branch was modified. Review and try the merge again." };
    p.state = "MERGED";
    p.mergeCommit = `merge-${n}`;
    return ok;
  }
  async closePr(repo: string, n: number, comment?: string): Promise<Result> {
    const p = this.pr(repo, n);
    p.state = "CLOSED";
    if (comment) p.comments.push(comment);
    this.log(`close ${repo}#${n}`);
    return ok;
  }
  async updateBranch(repo: string, n: number, expectedHead: string) {
    const p = this.pr(repo, n);
    if (p.head !== expectedHead) throw new Error("gh api -X: head moved");
    p.head = `${p.head}+`;
    this.log(`update-branch ${repo}#${n}`);
  }
  async mergeStatus(repo: string, n: number): Promise<MergeStatus> {
    const p = this.pr(repo, n);
    return { state: p.state, head: p.head, mergeState: p.mergeState, mergeCommit: p.mergeCommit };
  }
  async prBrief(repo: string, n: number): Promise<PrBrief> {
    const p = this.pr(repo, n);
    return { state: p.state, draft: p.draft, head: p.head, merged: p.state === "MERGED" };
  }
  async prFiles(): Promise<FileChange[]> {
    return [];
  }

  async readChecks(repo: string, n: number): Promise<ChecksRead> {
    const p = this.pr(repo, n);
    return { head: p.head, mergeable: "MERGEABLE", checks: p.checks };
  }
  async rerunFailed(repo: string, run: number) {
    this.log(`rerun ${repo} ${run}`);
  }
  async cancelRun(repo: string, run: number) {
    this.log(`cancel ${repo} ${run}`);
  }
  async failedLog(_repo: string, run: number) {
    return `run ${run}: failed\n`;
  }
  readonly jobLogs = new Map<number, string>();
  async jobLog(_repo: string, job: number) {
    const text = this.jobLogs.get(job);
    if (text === undefined) throw new Error(`gh api: Not Found (HTTP 404)`);
    return text;
  }

  async codeScanningAlerts(_repo: string, _n: number): Promise<CodeScanningAlert[]> {
    return [];
  }

  async listDeployments(repo: string, environment: string, sha?: string) {
    this.log(`deployments ${repo}${sha ? ` ${sha}` : ""}`);
    return this.deployments
      .filter((d) => d.repo === repo && (!sha || d.sha === sha))
      .map(({ id, sha, task, createdAt, payload }) => ({ id, sha, task, createdAt, payload }))
      .reverse()
      .slice(0, environment ? 30 : 30);
  }
  async deploymentStatus(repo: string, id: number) {
    this.log(`deployment-status ${repo} ${id}`);
    return [...(this.deployments.find((d) => d.id === id)?.statuses ?? [])].pop() ?? null;
  }
  async createDeployment(repo: string, body: Record<string, unknown>) {
    const id = 100 + this.deployments.length;
    this.deployments.push({
      id,
      repo,
      sha: String(body.ref),
      task: String(body.task),
      createdAt: new Date().toISOString(),
      payload: body.payload,
      statuses: [],
    });
    this.log(`deploy ${repo} ${String(body.ref)}`);
    return id;
  }

  async repoInfo(repo: string) {
    return { name: repo, defaultBranch: "main" };
  }
  async activeOwnerLogin() {
    return this.me;
  }
  async ownerLogins() {
    return [this.me.toLowerCase()];
  }

  async readFile(repo: string, path: string, _ref?: string) {
    return this.files.get(`${repo}:${path}`) ?? null;
  }
  async greenChecks(): Promise<Set<string> | null> {
    return new Set();
  }
  async readSettings(): Promise<SettingsSnapshot> {
    throw new Error("settings are not faked");
  }
  async restoreSettings(): Promise<string[]> {
    throw new Error("settings are not faked");
  }
  async requiresStatusChecks() {
    return null;
  }
  async openPrsFrom() {
    return [];
  }
  async branchHead(): Promise<string> {
    throw new Error("branches are not faked");
  }
  async mergeBase() {
    return null;
  }
  async prPatches() {
    return [];
  }
  async commitChecks(): Promise<{ seen: Map<string, CheckState>; required: string[] }> {
    return { seen: new Map(), required: [] };
  }
  async listReleases(): Promise<ReleaseInfo[]> {
    return [];
  }
  async tagContains() {
    return null;
  }

  async listIssues(repo: string, _limit?: number): Promise<IssueRow[]> {
    return this.issues.filter((i) => i.repo === repo);
  }
  async readIssue(repo: string, n: number): Promise<IssueText> {
    const i = this.issues.find((x) => x.repo === repo && x.number === n);
    if (!i) throw new Error(`no issue ${repo}#${n}`);
    return i;
  }
  async commentOnIssue(repo: string, n: number, text: string) {
    ((await this.readIssue(repo, n)) as FakeForgeIssue).comments.push(text);
  }
  async addLabel(repo: string, n: number, label: string) {
    const i = (await this.readIssue(repo, n)) as FakeForgeIssue;
    if (!i.labels.includes(label)) i.labels.push(label);
  }
  async removeLabels(repo: string, n: number, labels: string[]) {
    const i = (await this.readIssue(repo, n)) as FakeForgeIssue;
    i.labels = i.labels.filter((l) => !labels.includes(l));
  }

  async labelEvents(repo: string, n: number, label: string) {
    const i = (await this.readIssue(repo, n)) as FakeForgeIssue;
    return i.labels
      .filter((l) => l === label)
      .map((l) => ({ label: l, actor: i.labeledBy?.[l] ?? "someone" }));
  }
  async openPrTitles(repo: string) {
    return this.prs
      .filter((p) => p.repo === repo && p.state === "OPEN")
      .map((p) => ({ branch: p.branch, title: p.title }));
  }

  async readPr(repo: string, n: number): Promise<PrState> {
    const p = this.pr(repo, n);
    return {
      state: p.state,
      mergedAt: p.state === "MERGED" ? "2026-10-26T12:00:00Z" : null,
      mergeCommit: p.mergeCommit,
      head: p.head,
      mergeable: "MERGEABLE",
      body: p.body,
      isDraft: p.draft,
      reviews: p.reviews.map((r) => ({ author: r.author, state: r.state, body: "", at: "", commit: null })),
      comments: p.comments.map((body, i) => ({ author: "towercab[bot]", body, at: "", id: `c${i + 1}` })),
    };
  }
  async readPrExtra(repo: string, n: number): Promise<Pick<PrState, "author" | "reviewDecision" | "base">> {
    return { author: "towercab[bot]", reviewDecision: "", base: this.pr(repo, n).base };
  }
  async prsOnBranch(repo: string, branch: string): Promise<BranchPr[]> {
    return this.prs
      .filter((p) => p.repo === repo && p.branch === branch)
      .map((p) => ({ number: p.number, state: p.state, author: "towercab[bot]" }));
  }
  async deleteBranch(repo: string, branch: string, intentsRepo: string | null) {
    if (!ownBranch(branch, repo === intentsRepo))
      throw new Error(`refusing to delete ${branch} of ${repo}: not a Towercab branch`);
    this.deleted.push(`${repo} ${branch}`);
    this.log(`delete-branch ${repo} ${branch}`);
  }
  async retireBranch(_repo: string, _n: number, _intentsRepo: string | null): Promise<string | null> {
    return null;
  }
  async upsertPrComment(repo: string, n: number, marker: string, text: string) {
    const p = this.pr(repo, n);
    const at = p.comments.findIndex((c) => c.split("\n", 1)[0]?.trim() === marker);
    if (at >= 0) p.comments[at] = text;
    else p.comments.push(text);
    this.log(`${at >= 0 ? "edit-comment" : "comment"} ${repo}#${n}`);
    return { edited: at >= 0 };
  }
  async assignOwner(repo: string, n: number) {
    this.log(`assign ${repo}#${n} ${this.me}`);
    return true;
  }
  async codeowners(): Promise<string | null> {
    return null;
  }
  async changedPaths(): Promise<string[] | null> {
    return [];
  }
  async approvedReviewIds(): Promise<Set<string>> {
    return new Set();
  }
  async requiredApprovals(): Promise<number | null> {
    return null;
  }
  async requestReviewers(repo: string, n: number, logins: string[]) {
    for (const l of logins) this.log(`request-review ${repo}#${n} ${l}`);
    return { failed: [] as string[] };
  }
  async readProposed(_repo: string, _cache: ProposedCache, _bot: string): Promise<ProposedPr[]> {
    return [];
  }
}
