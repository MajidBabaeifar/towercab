// JIRA-9: the ticket key in branch names, PR titles and commit scopes. A key that doesn't look like one
// is left out everywhere, so nothing odd from a file reaches a branch name or a title.

/** A Jira issue key: project key, a dash, a number. */
const KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/;

/** The key if it is well formed, else null. */
export function validKey(k: string | null | undefined): string | null {
  const t = (k ?? "").trim();
  return KEY.test(t) ? t : null;
}

/** JIRA-9: the intent's usable ticket key, or null. */
export function jiraKey(intent: { jira?: string | null }): string | null {
  return validKey(intent.jira);
}

/** JIRA-9: `<KEY>: <title>` for a PR title; the title as it is without a key. */
export function withKey(intent: { jira?: string | null }, title: string): string {
  const key = jiraKey(intent);
  return key ? `${key}: ${title}` : title;
}

/** JIRA-9: the slug of a keyed intent's branch, `<KEY>-<slug>`: `towercab/<id>-<KEY>-<slug>`. */
export function branchSlug(intent: { jira?: string | null; slug: string }): string {
  const key = jiraKey(intent);
  return key ? `${key}-${intent.slug}` : intent.slug;
}

/** A PR title that may start with `<KEY>: ` (the intents PR matcher accepts it). */
export const KEY_PREFIX = "(?:[A-Z][A-Z0-9_]+-[0-9]+: )?";
