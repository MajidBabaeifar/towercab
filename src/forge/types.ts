// Which host a repo lives on (GL-3). A repo's slug is `owner/name` on GitHub and
// `gitlab:group/subgroup/project` on GitLab; the slug is what `RepoConfig.github` holds.

import { isRepoName } from "../config.ts";

export const GITLAB = "gitlab:";

export function isGitlab(slug: string): boolean {
  return slug.startsWith(GITLAB);
}

/** `group/subgroup/project` of a GitLab slug. */
export function gitlabPath(slug: string): string {
  return slug.slice(GITLAB.length);
}

/**
 * The project path of what a person typed (`gitlab:g/s/p`, or a URL on `host`; `.git` and a trailing
 * slash are fine), or null: two or more segments, each a repo name (INT-2).
 */
export function parseGitlabProject(text: string, host: string | null): string | null {
  let s = text.trim();
  if (s.startsWith(GITLAB)) s = s.slice(GITLAB.length);
  else if (host && s.startsWith(`https://${host}/`)) s = s.slice(`https://${host}/`.length);
  else return null;
  s = s.replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = s.split("/");
  return parts.length >= 2 && parts.every(isRepoName) ? parts.join("/") : null;
}
