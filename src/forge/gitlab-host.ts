// GitLab as a `Forge` (GL-13): the stages ask for what they need in the forge's terms and `GitLabForge`
// answers with REST. What GitLab has no counterpart for (code scanning, deployments, releases, settings
// scripts) answers neutrally, as a host without that feature would.

import {
  type Bot,
  type BranchPr,
  type CheckState,
  type ChecksRead,
  type CodeScanningAlert,
  type CommitProof,
  type Deployment,
  type DeploymentStatus,
  type FileChange,
  type Forge,
  ForgeDenied,
  type GitAuth,
  type IssueRow,
  type IssueText,
  type MergeMethod,
  type MergeStatus,
  type PrBrief,
  type PrState,
  type ReleaseInfo,
  type Result,
  type Review,
  type SettingsSnapshot,
} from "../forge.ts";
import { ownBranch } from "../github/branches.ts";
import type { ProposedPr } from "../github/proposed.ts";
import type { GitLabForge, MrRow } from "./gitlab.ts";
import type { GlabOwner } from "./gitlab-owner.ts";

const NO_SETTINGS = "GitLab repos have no settings script";

/** GitLab's `detailed_merge_status` in the words the merge stage reads (the merge states of `forge.ts`). */
export function mergeStateOf(status: string): string {
  switch (status) {
    case "mergeable":
      return "CLEAN";
    case "need_rebase":
      return "BEHIND";
    case "conflict":
      return "DIRTY";
    case "draft_status":
      return "DRAFT";
    default:
      return "BLOCKED";
  }
}

const ok = (): Result => ({ ok: true, reason: "" });
const fail = (e: unknown): Result => ({ ok: false, reason: (e as Error).message });

export class GitLabHost implements Forge {
  readonly me: string;
  private readonly gl: GitLabForge;
  private readonly glab: GlabOwner | null;

  constructor(gl: GitLabForge, glab: GlabOwner | null = null) {
    this.gl = gl;
    this.glab = glab;
    this.me = gl.me;
  }

  bot(): Promise<Bot> {
    return this.gl.bot();
  }
  gitAuth(_repo: string): Promise<GitAuth> {
    return this.gl.gitAuth();
  }

  /** GL-8: the same forge under the owner's own `glab` login, for merge, note and close. */
  asOwner(): Forge {
    const glab = this.glab;
    const base = this;
    const refuse = (): never => {
      throw new Error("acting as the owner on GitLab needs glab");
    };
    return new Proxy(this, {
      get(target, prop) {
        if (prop === "mergePr") {
          return async (repo: string, n: number, o: { method: MergeMethod; head?: string }) => {
            if (!glab) return refuse();
            try {
              await glab.approve(repo, n, o.head ?? (await base.gl.view(repo, n)).head);
              return ok();
            } catch (e) {
              return fail(e);
            }
          };
        }
        if (prop === "commentOnPr") {
          return async (repo: string, n: number, text: string) => {
            if (!glab) return refuse();
            try {
              await glab.reply(repo, n, text);
              return ok();
            } catch (e) {
              return fail(e);
            }
          };
        }
        if (prop === "closePr") {
          return async (repo: string, n: number, comment?: string) => {
            if (!glab) return refuse();
            try {
              if (comment) await glab.reply(repo, n, comment);
              await glab.close(repo, n);
              return ok();
            } catch (e) {
              return fail(e);
            }
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  async openPr(
    repo: string,
    o: { base: string; head: string; title: string; body: string },
  ): Promise<number | null> {
    return (await this.gl.openPr(repo, o)).number;
  }
  async openPrOn(repo: string, head: string): Promise<number | null> {
    return (await this.gl.listMrs(repo, "opened", { branch: head }))[0]?.iid ?? null;
  }
  async openPrBranches(repo: string): Promise<{ number: number; branch: string }[]> {
    return (await this.gl.listMrs(repo, "opened")).map((r) => ({ number: r.iid, branch: r.branch }));
  }
  async mergedPrBranches(
    repo: string,
  ): Promise<{ number: number; branch: string; mergeCommit: string | null }[]> {
    return (await this.gl.listMrs(repo, "merged", { limit: 300 })).map((r) => ({
      number: r.iid,
      branch: r.branch,
      mergeCommit: r.mergeCommit,
    }));
  }
  async reviews(repo: string, n: number): Promise<Review[]> {
    return (await this.gl.approvers(repo, n)).map((author) => ({ author, state: "APPROVED" }));
  }
  updatePrBody(repo: string, n: number, body: string): Promise<void> {
    return this.gl.setBody(repo, n, body);
  }
  async commentOnPr(repo: string, n: number, text: string): Promise<Result> {
    try {
      await this.gl.comment(repo, n, text);
      return ok();
    } catch (e) {
      return fail(e);
    }
  }
  async markReady(repo: string, n: number): Promise<Result> {
    try {
      await this.gl.markReady(repo, n);
      return ok();
    } catch (e) {
      return fail(e);
    }
  }
  async mergePr(repo: string, n: number, o: { method: MergeMethod; head?: string }): Promise<Result> {
    try {
      const head = o.head ?? (await this.gl.view(repo, n)).head;
      const r = await this.gl.merge(repo, n, head);
      return r.merged ? ok() : { ok: false, reason: r.reason };
    } catch (e) {
      return fail(e);
    }
  }
  async closePr(repo: string, n: number, comment?: string): Promise<Result> {
    try {
      await this.gl.close(repo, n, comment);
      return ok();
    } catch (e) {
      return fail(e);
    }
  }
  async updateBranch(repo: string, n: number, expectedHead: string): Promise<void> {
    const v = await this.gl.view(repo, n);
    if (v.head !== expectedHead)
      throw new Error(`the head moved: ${v.head.slice(0, 7)} is not ${expectedHead.slice(0, 7)}`);
    await this.gl.updateBranch(repo, n);
  }
  async mergeStatus(repo: string, n: number): Promise<MergeStatus> {
    const v = await this.gl.view(repo, n);
    return { state: v.state, head: v.head, mergeState: mergeStateOf(v.status), mergeCommit: v.mergeCommit };
  }
  async prBrief(repo: string, n: number): Promise<PrBrief> {
    const v = await this.gl.view(repo, n);
    return { state: v.state, draft: v.draft, head: v.head, merged: v.state === "MERGED" };
  }
  async prFiles(repo: string, n: number): Promise<FileChange[]> {
    return (await this.gl.diffs(repo, n)).map((d) => ({ filename: d.name, status: d.status }));
  }

  // GitLab links no account to a commit's e-mail, so nobody is vouched for (AUT-35).
  async commitLogins(): Promise<(string | null)[]> {
    return [null, null];
  }
  async commitProof(): Promise<CommitProof> {
    return { author: null, committer: null, verified: false };
  }

  readChecks(repo: string, n: number): Promise<ChecksRead> {
    return this.gl.readChecks(repo, n);
  }
  rerunFailed(repo: string, run: number): Promise<void> {
    return this.gl.rerunFailed(repo, run);
  }
  cancelRun(repo: string, run: number): Promise<void> {
    return this.gl.cancelRun(repo, run);
  }
  failedLog(repo: string, run: number): Promise<string> {
    return this.gl.failedLog(repo, run);
  }
  jobLog(repo: string, job: number): Promise<string> {
    return this.gl.jobLog(repo, job);
  }
  async codeScanningAlerts(): Promise<CodeScanningAlert[]> {
    return [];
  }

  async listDeployments(): Promise<Deployment[]> {
    return [];
  }
  async deploymentStatus(): Promise<DeploymentStatus | null> {
    return null;
  }
  async createDeployment(): Promise<number> {
    throw new ForgeDenied("GitLab deployments are not supported");
  }

  async repoInfo(repo: string): Promise<{ name: string; defaultBranch: string }> {
    const p = await this.gl.project(repo.replace(/^gitlab:/, ""));
    return { name: p.path, defaultBranch: p.base };
  }

  async activeOwnerLogin(): Promise<string | null> {
    return null;
  }
  async ownerLogins(): Promise<string[]> {
    return [this.me.toLowerCase()];
  }

  readFile(repo: string, path: string, ref: string): Promise<string | null> {
    return this.gl.readFile(repo, path, ref);
  }
  async greenChecks(): Promise<Set<string> | null> {
    return null;
  }
  async readSettings(): Promise<SettingsSnapshot> {
    throw new ForgeDenied(NO_SETTINGS);
  }
  async restoreSettings(): Promise<string[]> {
    return [];
  }
  async requiresStatusChecks(): Promise<boolean | null> {
    return null;
  }
  async openPrsFrom(
    repo: string,
    branch: string,
  ): Promise<{ number: number; body: string | null; author: string; head: string }[]> {
    return (await this.gl.listMrs(repo, "opened", { branch }))
      .filter((r) => !r.crossProject)
      .map((r) => ({ number: r.iid, body: r.body, author: r.author, head: r.head }));
  }
  branchHead(repo: string, branch: string): Promise<string> {
    return this.gl.branchHead(repo, branch);
  }
  mergeBase(repo: string, a: string, b: string): Promise<string | null> {
    return this.gl.mergeBase(repo, a, b);
  }
  async prPatches(repo: string, n: number): Promise<{ name: string; patch: string | null }[]> {
    return (await this.gl.diffs(repo, n)).map((d) => ({ name: d.name, patch: d.patch }));
  }
  async commitChecks(): Promise<{ seen: Map<string, CheckState>; required: string[] }> {
    return { seen: new Map(), required: [] };
  }
  async listReleases(): Promise<ReleaseInfo[]> {
    return [];
  }
  async tagContains(): Promise<boolean | null> {
    return null;
  }

  listIssues(repo: string, limit: number): Promise<IssueRow[]> {
    return this.gl.listIssues(repo, limit);
  }
  readIssue(repo: string, n: number): Promise<IssueText> {
    return this.gl.readIssue(repo, n);
  }
  commentOnIssue(repo: string, n: number, text: string): Promise<void> {
    return this.gl.commentOnIssue(repo, n, text);
  }
  addLabel(repo: string, n: number, label: string, color: string): Promise<void> {
    return this.gl.addLabel(repo, n, label, color);
  }
  removeLabels(repo: string, n: number, labels: string[]): Promise<void> {
    return this.gl.removeLabels(repo, n, labels);
  }
  async labelEvents(
    repo: string,
    n: number,
    label: string,
  ): Promise<{ label: string; actor: string | null }[]> {
    const actor = await this.gl.labelAddedBy(repo, n, label);
    return actor === null ? [] : [{ label, actor }];
  }

  async openPrTitles(repo: string, limit: number): Promise<{ branch: string; title: string }[]> {
    return (await this.gl.listMrs(repo, "opened", { limit })).map((r) => ({
      branch: r.branch,
      title: r.title,
    }));
  }
  readPr(repo: string, n: number): Promise<PrState> {
    return this.gl.readPr(repo, n);
  }
  async readPrExtra(repo: string, n: number): Promise<Pick<PrState, "author" | "reviewDecision" | "base">> {
    const rows = await this.gl.listMrs(repo, "all");
    const r = rows.find((x) => x.iid === n);
    return r ? { author: r.author } : {};
  }
  async prsOnBranch(repo: string, branch: string): Promise<BranchPr[]> {
    return (await this.gl.listMrs(repo, "all", { branch })).map((r) => ({
      number: r.iid,
      state: r.state,
      author: r.author,
    }));
  }
  async deleteBranch(repo: string, branch: string, intentsRepo: string | null): Promise<void> {
    if (!ownBranch(branch, repo === intentsRepo)) {
      throw new Error(`refusing to delete ${branch} of ${repo}: not a Towercab branch`);
    }
    await this.gl.deleteBranch(repo, branch);
  }
  async retireBranch(repo: string, n: number, intentsRepo: string | null): Promise<string | null> {
    const all = await this.gl.listMrs(repo, "all");
    const mr: MrRow | undefined = all.find((r) => r.iid === n);
    if (!mr || mr.state !== "CLOSED" || mr.crossProject) return null;
    if (!ownBranch(mr.branch, repo === intentsRepo)) return null;
    if (mr.author.toLowerCase() !== (await this.gl.bot()).login.toLowerCase()) return null;
    if (all.some((r) => r.iid !== n && r.branch === mr.branch && r.state === "OPEN")) return null;
    await this.deleteBranch(repo, mr.branch, intentsRepo);
    return mr.branch;
  }
  upsertPrComment(
    repo: string,
    n: number,
    marker: string,
    text: string,
  ): Promise<{ edited: boolean; url?: string }> {
    return this.gl.upsertNote(repo, n, marker, text);
  }
  assignOwner(repo: string, n: number): Promise<boolean> {
    return this.gl.assign(repo, n, this.me, "assignee");
  }
  async codeowners(repo: string, base: string): Promise<string | null> {
    for (const path of ["CODEOWNERS", ".gitlab/CODEOWNERS", "docs/CODEOWNERS"]) {
      const text = await this.gl.readFile(repo, path, base);
      if (text !== null) return text;
    }
    return null;
  }
  async changedPaths(repo: string, n: number): Promise<string[] | null> {
    try {
      return (await this.gl.diffs(repo, n)).map((d) => d.name);
    } catch {
      return null;
    }
  }
  // GL-15: no review id carries over an approval to a later head.
  async approvedReviewIds(): Promise<Set<string>> {
    return new Set();
  }
  async requiredApprovals(): Promise<number | null> {
    return null;
  }
  async requestReviewers(repo: string, n: number, logins: string[]): Promise<{ failed: string[] }> {
    const failed: string[] = [];
    for (const l of logins) if (!(await this.gl.assign(repo, n, l, "reviewer"))) failed.push(l);
    return { failed };
  }
  async readProposed(): Promise<ProposedPr[]> {
    return [];
  }
}
