// People and roles (USR-1, USR-2, USR-5): the one pure function every channel asks, `can`. The page, the
// API, GitHub events and Telegram have no rules of their own.

export const ROLES = ["viewer", "contributor", "maintainer", "admin"] as const;
export type UserRole = (typeof ROLES)[number];

/** What a person may be asked to do; the lowest role that may do it is in `NEEDS`. */
export type UserAction =
  | "read"
  | "create"
  | "answer"
  | "approve"
  | "merge"
  | "reply"
  | "start"
  | "boost"
  | "drop"
  | "edit"
  | "confirm"
  | "raise"
  | "lower"
  | "retry"
  | "pause"
  | "resume"
  | "users"
  | "settings";

/** USR-1: each action with the lowest role that may do it; every role above may too. */
export const NEEDS: Record<UserAction, UserRole> = {
  read: "viewer",
  create: "contributor",
  answer: "contributor",
  approve: "maintainer",
  merge: "maintainer",
  reply: "maintainer",
  start: "maintainer",
  boost: "maintainer",
  drop: "maintainer",
  edit: "maintainer",
  confirm: "maintainer",
  raise: "maintainer",
  lower: "maintainer",
  retry: "maintainer",
  pause: "maintainer",
  resume: "maintainer",
  users: "admin",
  settings: "admin",
};

/** The part of a person the rules need (USR-5): a default role and optional roles per repo. */
export interface Person {
  login: string;
  role: UserRole;
  /** `{ "acme/api": "maintainer" }`; never `admin`. */
  repoRoles?: Readonly<Record<string, UserRole>>;
  /** Set when an admin disabled the person: they can do nothing. */
  disabled?: boolean;
}

export const isRole = (s: unknown): s is UserRole => ROLES.includes(s as UserRole);

/** The rank of a role: viewer 0 … admin 3. */
export const rank = (r: UserRole): number => ROLES.indexOf(r);

/**
 * USR-5: the person's role for `repo`: the per-repo role if there is one, else the default. Admin is global:
 * an admin stays admin everywhere, and a per-repo role never makes anyone admin of one repo.
 */
export function roleOn(p: Person, repo?: string | null): UserRole {
  if (p.role === "admin") return "admin";
  const own = repo ? p.repoRoles?.[repo] : undefined;
  return own && own !== "admin" && isRole(own) ? own : p.role;
}

/** USR-1: whether `p` may do `action` on `repo` (none: an action with no repo, so the default role counts). */
export function can(p: Person | null, action: UserAction, repo?: string | null): boolean {
  if (!p || p.disabled) return false;
  return rank(roleOn(p, repo)) >= rank(NEEDS[action]);
}

/** USR-7: the reason a 403 gives, "your role (viewer) can't <action> on <repo>". */
export function refusal(p: Person, action: UserAction, repo?: string | null): string {
  return `your role (${roleOn(p, repo)}) can't ${action}${repo ? ` on ${repo}` : ""}`;
}

/** UI-220: the tooltip of a disabled button, "Needs maintainer on <repo> (you are viewer)". */
export function needsText(p: Person, action: UserAction, repo?: string | null): string {
  return `Needs ${NEEDS[action]}${repo ? ` on ${repo}` : ""} (you are ${roleOn(p, repo)})`;
}

/** USR-2: a team gives at most contributor; a higher role is refused when it is set. */
export function checkTeamRole(role: unknown): UserRole {
  if (!isRole(role)) throw new Error(`"${String(role)}" isn't a role: use viewer or contributor`);
  if (rank(role) > rank("contributor")) {
    throw new Error(`a team can give at most contributor, not ${role}: grant ${role} to a person by name`);
  }
  return role;
}

/** USR-5: repo roles are real roles, and never admin (admin is global). */
export function checkRepoRoles(x: unknown): Record<string, UserRole> {
  if (x === undefined || x === null) return {};
  if (typeof x !== "object" || Array.isArray(x))
    throw new Error("repo roles must be an object of repo → role");
  const out: Record<string, UserRole> = {};
  for (const [repo, role] of Object.entries(x)) {
    if (!isRole(role)) throw new Error(`"${String(role)}" isn't a role (repo ${repo})`);
    if (role === "admin") throw new Error(`admin is never per repo (${repo}): set it as the default role`);
    out[repo] = role;
  }
  return out;
}

/**
 * USR-6: the last enabled admin can't be removed, demoted or disabled. `people` is every person now; the
 * change leaves `login` as `after` (null: removed or disabled).
 */
export function leavesAdmin(
  people: readonly Person[],
  login: string,
  after: { role: UserRole } | null,
): boolean {
  const key = login.toLowerCase();
  const left = people.filter((p) => !p.disabled && p.role === "admin" && p.login.toLowerCase() !== key);
  return left.length > 0 || after?.role === "admin";
}
