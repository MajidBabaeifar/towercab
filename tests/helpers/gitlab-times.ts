// The fake GitLab with the times GL-15 compares: when each approval was given and when the newest commit was pushed.

import type { Http, HttpRequest, HttpResponse } from "../../src/github/app.ts";
import { FakeGitLab } from "./gitlab.ts";

export class FakeGitLabTimes extends FakeGitLab {
  /** `approved_at` per merge request and person (`<iid>:<user>`); a person without one has none in the answer. */
  readonly approvedAt = new Map<string, string>();
  /** `created_at` of each version of a merge request, by iid; none: GitLab answers 404. */
  readonly versions = new Map<number, string[]>();

  constructor() {
    super();
    const inner: Http = this.http;
    (this as { http: Http }).http = async (req: HttpRequest): Promise<HttpResponse> => {
      const u = new URL(req.url);
      const m = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)\/(approvals|versions)$/.exec(
        u.pathname,
      );
      if (!m || req.method !== "GET") return inner(req);
      const iid = Number(m[2]);
      if (m[3] === "versions") {
        const v = this.versions.get(iid);
        if (!v) return { status: 404, text: JSON.stringify({ message: "404 Not Found" }) };
        return { status: 200, text: JSON.stringify(v.map((created_at, id) => ({ id, created_at }))) };
      }
      const res = await inner(req);
      if (res.status !== 200) return res;
      const body = JSON.parse(res.text) as { approved_by: { user: { username: string } }[] };
      for (const a of body.approved_by as { user: { username: string }; approved_at?: string }[]) {
        const at = this.approvedAt.get(`${iid}:${a.user.username}`);
        if (at) a.approved_at = at;
      }
      return { status: 200, text: JSON.stringify(body) };
    };
  }
}
