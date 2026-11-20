// The code host of a `Pipe` world, at the `Forge` interface: its pull requests, issues and deployments
// are the world's own records, and a merge or a branch update happens for real in the bare repos.
// No `gh` command line is built or read here. How the GitHub forge words its `gh` calls is covered by
// `tests/github/forge.test.ts` and `tests/github/forge-methods.test.ts`, not by the pipeline tests.

import {
  type Check,
  type Deployment,
  type DeploymentStatus,
  type Forge,
  ForgeDenied,
  type IssueRow,
  type IssueText,
  type PrState,
} from "../../src/forge.ts";
import { ownBranch } from "../../src/github/branches.ts";
import { checksOf } from "../../src/github/checks.ts";
import { isBot } from "../../src/github/events.ts";
import type { GitHub } from "../../src/handlers.ts";
import { FakeForge } from "./fake-forge.ts";
import type { FakeDeployment, FakeIssue, FakePr } from "./pipe.ts";

/** What a `PipeForge` reads and changes: the `Pipe` world (its public members only). */
export interface PipeWorld {
  readonly prs: FakePr[];
  readonly issues: FakeIssue[];
  readonly deployments: FakeDeployment[];
  readonly reruns: number[];
  readonly cancels: number[];
  readonly updates: string[];
  readonly deleted: string[];
  readonly jobLogs: Map<number, string>;
  readonly alertReads: string[];
  alerts: { rule: string; path: string; line: number; message: string }[];
  alertsDenied: boolean;
  alertsFail: string;
  changedFiles: string[];
  runViewFails: boolean;
  mergedListFails: boolean;
  newPrChecks: FakePr["checks"];
  deleteFail: ((repo: string, branch: string) => string | null) | null;
  /** Fails an issue call with this reason (the older tests' hook: `kind` is the call, `list`, `comment`…). */
  issueFail: ((args: string[]) => string | null) | null;
  /** One line per issue call, for the tests that count them. */
  readonly issueCalls: string[];
  nextPr: number;
  nextComment: number;
  nextDeployment: number;
  headSha(repo: string, branch: string): string;
  mergePr(p: FakePr): void;
  updateBranch(p: FakePr): void;
  deploy(repo: string, sha: string, task: string, payload: unknown, id?: number): FakeDeployment | null;
  bareOf(repo: string): string;
  deleteRef(repo: string, branch: string): boolean;
  at(): string;
}

const BOT = "towercab[bot]";

export class PipeForge extends FakeForge implements GitHub {
  private readonly world: PipeWorld;
  /** Who acts: the bot, or the owner (`asOwner`). */
  private actor = BOT;

  constructor(world: PipeWorld) {
    super("owner");
    this.world = world;
  }

  /** The raw `gh` side of `Host` is not faked: a flow that still reaches it fails loudly. */
  gh: GitHub["gh"] = async (_repo, args) => {
    throw new Error(`raw gh is not faked: ${args.join(" ")}`);
  };
  owner: GitHub["owner"] = async (args) => {
    throw new Error(`raw gh is not faked: ${args.join(" ")}`);
  };

  override asOwner(): Forge {
    return Object.assign(Object.create(this) as PipeForge, { actor: "owner" });
  }

  private find(repo: string, n: number): FakePr | undefined {
    return this.world.prs.find((p) => p.repo === repo && p.number === n);
  }

  private get(repo: string, n: number): FakePr {
    const p = this.find(repo, n);
    if (!p) throw new Error(`no PR ${repo}#${n}`);
    return p;
  }

  private head(p: FakePr): string {
    try {
      return this.world.headSha(p.repo, p.head);
    } catch {
      // The branch was deleted: a closed PR keeps no head to read.
      return "";
    }
  }

  private say(p: FakePr, author: string, body: string): void {
    p.comments.push({ id: `c${this.world.nextComment++}`, author, body, at: this.world.at() });
  }

  override async openPr(repo: string, o: { base: string; head: string; title: string; body: string }) {
    if (this.world.prs.some((x) => x.repo === repo && x.head === o.head && x.state === "OPEN"))
      throw new Error(
        `gh pr create: a pull request for branch "${o.head}" into branch "main" already exists`,
      );
    const p: FakePr = {
      number: this.world.nextPr++,
      repo,
      head: o.head,
      base: o.base,
      title: o.title,
      body: o.body,
      state: "OPEN",
      author: BOT,
      mergeCommit: null,
      comments: [],
      reviews: [],
      checks: (pr, head) => this.world.newPrChecks(pr, head),
      mergeable: "MERGEABLE",
      mergeStates: [],
    };
    this.world.prs.push(p);
    this.log(`open ${repo}#${p.number} ${o.head}`);
    return p.number;
  }
  override async openPrOn(repo: string, head: string) {
    return (
      this.world.prs.find((x) => x.repo === repo && x.head === head && x.state === "OPEN")?.number ?? null
    );
  }
  override async openPrBranches(repo: string) {
    return this.world.prs
      .filter((x) => x.repo === repo && x.state === "OPEN")
      .map((x) => ({ number: x.number, branch: x.head }));
  }
  override async openPrTitles(repo: string) {
    return this.world.prs
      .filter((x) => x.repo === repo && x.state === "OPEN")
      .map((x) => ({ branch: x.head, title: x.title }));
  }
  override async mergedPrBranches(repo: string) {
    if (this.world.mergedListFails) throw new Error("gh pr list: HTTP 502: bad gateway");
    return this.world.prs
      .filter((x) => x.repo === repo && x.state === "MERGED")
      .map((x) => ({ number: x.number, branch: x.head, mergeCommit: x.mergeCommit }));
  }
  override async reviews(repo: string, n: number) {
    return this.get(repo, n).reviews.map((r) => ({ author: r.author, state: r.state }));
  }
  override async updatePrBody(repo: string, n: number, body: string) {
    const p = this.find(repo, n);
    if (p) p.body = body;
    this.log(`body ${repo}#${n}`);
  }
  override async commentOnPr(repo: string, n: number, text: string) {
    const p = this.find(repo, n);
    this.log(`comment ${repo}#${n}`);
    if (!p) return { ok: false, reason: `no PR ${repo}#${n}` };
    this.say(p, this.actor, text);
    return { ok: true, reason: "" };
  }
  override async markReady(repo: string, n: number) {
    this.log(`ready ${repo}#${n}`);
    return { ok: true, reason: "" };
  }
  override async mergePr(repo: string, n: number, o: { method: "squash"; head?: string }) {
    this.log(`merge ${repo}#${n} ${o.method}${o.head ? ` head=${o.head}` : ""}`);
    const p = this.find(repo, n);
    if (!p) return { ok: false, reason: `no PR ${repo}#${n}` };
    if (p.state !== "OPEN") return { ok: false, reason: `Pull request #${n} was already merged or closed` };
    if (o.head && o.head !== this.world.headSha(p.repo, p.head))
      return { ok: false, reason: "Head branch was modified. Review and try the merge again." };
    this.world.mergePr(p);
    return { ok: true, reason: "" };
  }
  override async closePr(repo: string, n: number, comment?: string) {
    const p = this.find(repo, n);
    this.log(`close ${repo}#${n}`);
    if (p) {
      p.state = "CLOSED";
      if (comment) this.say(p, BOT, comment);
    }
    return { ok: true, reason: "" };
  }
  override async updateBranch(repo: string, n: number, expectedHead: string) {
    this.log(`update-branch ${repo}#${n} ${expectedHead}`);
    this.world.updateBranch(this.get(repo, n));
  }
  override async mergeStatus(repo: string, n: number) {
    const p = this.get(repo, n);
    return {
      state: p.state,
      head: this.head(p),
      mergeState: p.mergeStates.shift() ?? "CLEAN",
      mergeCommit: p.mergeCommit,
    };
  }
  override async prBrief(repo: string, n: number) {
    const p = this.get(repo, n);
    return { state: p.state, draft: false, head: this.head(p), merged: p.state === "MERGED" };
  }
  override async prFiles() {
    return this.world.changedFiles.map((filename) => ({ filename, status: "modified" }));
  }

  override async readChecks(repo: string, n: number) {
    const p = this.get(repo, n);
    const head = this.head(p);
    const checks: Check[] = checksOf(p.checks(p, head));
    return { head, mergeable: p.mergeable, checks };
  }
  override async rerunFailed(repo: string, run: number) {
    this.world.reruns.push(run);
    this.log(`rerun ${repo} ${run}`);
  }
  override async cancelRun(repo: string, run: number) {
    this.world.cancels.push(run);
    this.log(`cancel ${repo} ${run}`);
  }
  override async failedLog(_repo: string, run: number) {
    if (this.world.runViewFails) throw new Error("gh run view: HTTP 410: the logs have expired");
    return `run ${run}: Error: a test failed\n`;
  }
  override async jobLog(_repo: string, job: number) {
    const text = this.world.jobLogs.get(job);
    if (text === undefined) throw new Error("gh api: gh: Not Found (HTTP 404)");
    return text;
  }
  override async codeScanningAlerts(repo: string, n: number) {
    this.world.alertReads.push(
      `repos/${repo}/code-scanning/alerts?ref=refs/pull/${n}/merge&state=open&per_page=100`,
    );
    if (this.world.alertsDenied)
      throw new ForgeDenied("gh: Resource not accessible by integration (HTTP 403)");
    if (this.world.alertsFail) throw new Error(this.world.alertsFail);
    return this.world.alerts.map((a) => ({ rule: a.rule, path: a.path, line: a.line, message: a.message }));
  }

  override async listDeployments(repo: string, environment: string, sha?: string): Promise<Deployment[]> {
    this.log(`deployments ${repo}${sha ? ` ${sha}` : ""}`);
    return [...this.world.deployments]
      .reverse()
      .filter((d) => d.repo === repo && d.environment === (environment || d.environment))
      .filter((d) => !sha || d.sha === sha)
      .slice(0, 30)
      .map((d) => ({ id: d.id, sha: d.sha, task: d.task, createdAt: d.created_at, payload: d.payload }));
  }
  override async deploymentStatus(repo: string, id: number): Promise<DeploymentStatus | null> {
    this.log(`deployment-status ${repo} ${id}`);
    const d = this.world.deployments.find((x) => x.id === id);
    const s = d?.statuses.at(-1);
    return s ? { state: s.state, description: s.description } : null;
  }
  override async createDeployment(repo: string, body: Record<string, unknown>) {
    const made = this.world.deploy(
      repo,
      String(body.ref),
      String(body.task),
      body.payload,
      this.world.nextDeployment++,
    )!;
    this.log(`deploy ${repo} ${String(body.ref)}`);
    return made.id;
  }

  // Issues. `issueFail` and `issueCalls` keep the shape the loop's own tests were written with.
  private issueCall(args: string[], line: string): void {
    this.log(line);
    this.world.issueCalls.push(args.join(" "));
    const bad = this.world.issueFail?.(args);
    if (bad) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${bad}`);
  }
  private issueOf(repo: string, n: number): FakeIssue {
    const it = this.world.issues.find((x) => x.repo === repo && x.number === n);
    if (!it) throw new Error(`issue ${n} not found`);
    return it;
  }
  override async listIssues(repo: string, limit: number): Promise<IssueRow[]> {
    this.issueCall(["issue", "list", "-R", repo, "--limit", String(limit)], `list-issues ${repo}`);
    return this.world.issues
      .filter((i) => i.repo === repo)
      .map((i) => ({
        number: i.number,
        url: `https://github.com/${repo}/issues/${i.number}`,
        state: i.state,
        author: i.author,
        labels: [...i.labels],
      }));
  }
  override async readIssue(repo: string, n: number): Promise<IssueText> {
    this.issueCall(["issue", "view", String(n), "-R", repo], `read-issue ${repo}#${n}`);
    const it = this.issueOf(repo, n);
    return { title: it.title, body: it.body, author: it.author, labels: [...it.labels] };
  }
  override async commentOnIssue(repo: string, n: number, text: string) {
    this.issueCall(["issue", "comment", String(n), "-R", repo], `comment-issue ${repo}#${n}`);
    this.issueOf(repo, n).comments.push(text);
  }
  override async addLabel(repo: string, n: number, label: string) {
    this.issueCall(
      ["issue", "edit", String(n), "-R", repo, "--add-label", label],
      `add-label ${repo}#${n} ${label}`,
    );
    const it = this.issueOf(repo, n);
    if (!it.labels.includes(label)) it.labels.push(label);
    it.labeledBy = { ...it.labeledBy, [label]: BOT };
  }
  override async removeLabels(repo: string, n: number, labels: string[]) {
    if (!labels.length) return;
    this.issueCall(
      ["issue", "edit", String(n), "-R", repo, "--remove-label", ...labels],
      `remove-labels ${repo}#${n} ${labels.join(",")}`,
    );
    const it = this.issueOf(repo, n);
    it.labels = it.labels.filter((l) => !labels.includes(l));
  }
  override async labelEvents(repo: string, n: number, label: string) {
    const it = this.issueOf(repo, n);
    return it.labels
      .filter((l) => l === label)
      .map((l) => ({ label: l, actor: it.labeledBy?.[l] ?? "someone" }));
  }

  override async readPr(repo: string, n: number): Promise<PrState> {
    const p = this.get(repo, n);
    return {
      state: p.state,
      mergedAt: p.state === "MERGED" ? "2026-10-26T12:00:00Z" : null,
      mergeCommit: p.mergeCommit,
      head: this.head(p),
      mergeable: p.mergeable,
      body: p.body,
      isDraft: false,
      reviews: p.reviews.map((r) => ({
        author: r.author,
        state: r.state,
        body: r.body,
        at: r.at,
        commit: r.commit,
      })),
      comments: p.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, at: c.at })),
    };
  }
  override async readPrExtra(repo: string, n: number) {
    return { author: this.get(repo, n).author, reviewDecision: "" };
  }
  override async prsOnBranch(repo: string, branch: string) {
    return this.world.prs
      .filter((x) => x.repo === repo && x.head === branch)
      .map((x) => ({ number: x.number, state: x.state, author: x.author }));
  }
  override async deleteBranch(repo: string, branch: string, intentsRepo: string | null) {
    if (!ownBranch(branch, repo === intentsRepo))
      throw new Error(`refusing to delete ${branch} of ${repo}: not a Towercab branch`);
    const bad = this.world.deleteFail?.(repo, branch);
    if (bad) throw new Error(`gh api delete branch: ${bad}`);
    // A branch that is already gone counts as deleted.
    if (this.world.deleteRef(repo, branch)) this.world.deleted.push(`${repo} ${branch}`);
    this.log(`delete-branch ${repo} ${branch}`);
  }
  override async retireBranch(repo: string, n: number, intentsRepo: string | null) {
    const p = this.get(repo, n);
    if (p.state !== "CLOSED") return null;
    if (!ownBranch(p.head, repo === intentsRepo)) return null;
    if (!isBot(p.author, BOT)) return null;
    const others = this.world.prs.filter((x) => x.repo === repo && x.head === p.head);
    if (others.some((x) => x.number !== n && x.state === "OPEN")) return null;
    await this.deleteBranch(repo, p.head, intentsRepo);
    return p.head;
  }
  override async upsertPrComment(repo: string, n: number, marker: string, text: string) {
    const p = this.find(repo, n);
    const mine = p?.comments.find(
      (c) => (c.body.split("\n", 1)[0] ?? "").trim() === marker && isBot(c.author, BOT),
    );
    if (mine) {
      mine.body = text;
      this.log(`edit-comment ${repo}#${n}`);
      return { edited: true };
    }
    if (!p) throw new Error(`gh pr comment: no PR ${repo}#${n}`);
    this.say(p, BOT, text);
    this.log(`comment ${repo}#${n}`);
    return { edited: false };
  }
  override async requestReviewers(repo: string, n: number, logins: string[]) {
    for (const l of logins) this.log(`request-review ${repo}#${n} ${l}`);
    return { failed: [] as string[] };
  }
  override async assignOwner(repo: string, n: number) {
    this.log(`assign ${repo}#${n} ${this.me}`);
    return true;
  }
  override async changedPaths() {
    return [...this.world.changedFiles];
  }
  override async requiredApprovals() {
    return 0;
  }
}
