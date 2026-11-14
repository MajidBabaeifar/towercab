// Which host a repo lives on (GL-3). A repo's slug is `owner/name` on GitHub and
// `gitlab:group/subgroup/project` on GitLab; the slug is what `RepoConfig.github` holds.

import { isRepoName } from "../config.ts";

export const GITLAB = "gitlab:";

export function isGitlab(slug: string): boolean {
  return slug.startsWith(GITLAB);
}

let webHost = "gitlab.com";

/** The host GitLab links point at: `[gitlab].api_base`'s, set once when the config is read. */
export function setGitlabHost(host: string): void {
  webHost = host;
}

/** The web page of pull request or merge request `n` of `slug`, on its own host. */
export function changeUrl(slug: string, n: number): string {
  return isGitlab(slug)
    ? `https://${webHost}/${gitlabPath(slug)}/-/merge_requests/${n}`
    : `https://github.com/${slug}/pull/${n}`;
}

/** The web page of `path` at `ref` in `slug`. */
export function blobUrl(slug: string, ref: string, path: string): string {
  return isGitlab(slug)
    ? `https://${webHost}/${gitlabPath(slug)}/-/blob/${ref}/${path}`
    : `https://github.com/${slug}/blob/${ref}/${path}`;
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
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  const parts = s.split("/");
  return parts.length >= 2 && parts.every(isRepoName) ? parts.join("/") : null;
}
