// The fake GitLab with the merge request list (`GET …/merge_requests?state=…&source_branch=…`).

import type { Http, HttpRequest, HttpResponse } from "../../src/github/app.ts";
import { FakeGitLabTimes } from "./gitlab-times.ts";

export class FakeGitLabLists extends FakeGitLabTimes {
  constructor() {
    super();
    const inner: Http = this.http;
    (this as { http: Http }).http = async (req: HttpRequest): Promise<HttpResponse> => {
      const u = new URL(req.url);
      const m = /^\/api\/v4\/projects\/([^/]+)\/merge_requests$/.exec(u.pathname);
      if (!m || req.method !== "GET") return inner(req);
      const p = this.projects.get(decodeURIComponent(m[1]!));
      if (!p) return { status: 404, text: JSON.stringify({ message: "404 Project Not Found" }) };
      const state = u.searchParams.get("state") ?? "all";
      const branch = u.searchParams.get("source_branch");
      const rows = p.mrs
        .filter((x) => (state === "all" || x.state === state) && (!branch || x.source_branch === branch))
        .map((x) => ({
          iid: x.iid,
          title: x.title,
          description: x.description,
          state: x.state,
          sha: x.sha,
          source_branch: x.source_branch,
          target_branch: x.target_branch,
          merge_commit_sha: x.merge_commit_sha,
          author: { username: this.bot.username },
        }));
      const page = Number(u.searchParams.get("page") ?? 1);
      return { status: 200, text: JSON.stringify(page === 1 ? rows : []) };
    };
  }
}
