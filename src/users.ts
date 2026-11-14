// Who may do what (USR-1, USR-5, USR-13). Pure: the page's API, the GitHub events, Telegram and the
// autonomy rules all ask `can`, so no channel has rules of its own.

export const ROLES = ["viewer", "contributor", "maintainer", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** What a person can ask to do (USR-1). `read` is every GET of the page. */
export type Action =
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
  | "manage_users"
  | "settings";

/** The lowest role that may do each action; every role above it may too (USR-1). */
const NEEDS: Record<Action, Role> = {
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
  manage_users: "admin",
  settings: "admin",
};

export const ACTIONS = Object.keys(NEEDS) as Action[];

/** A person Towercab knows (the `users` table, USR-2). `repos` holds per-repo roles (USR-5). */
export interface User {
  /** The lower-cased GitHub login. */
  login: string;
  /** The default role: the one for every repo without its own entry. */
  role: Role;
  repos: Readonly<Record<string, Role>>;
  disabled?: boolean;
}

export function isRole(s: unknown): s is Role {
  return typeof s === "string" && (ROLES as readonly string[]).includes(s);
}

/** 0 (viewer) to 3 (admin). */
export function roleRank(r: Role): number {
  return ROLES.indexOf(r);
}

/** The lowest role that may do `action`. */
export function roleNeeded(action: Action): Role {
  return NEEDS[action];
}

/**
 * The role a person has on `repo` (USR-5): their own entry for that repo, else their default. Admin is
 * global: an admin is one everywhere, and a per-repo entry never makes anyone admin (it counts as at most
 * maintainer). With no repo the default applies.
 */
export function roleFor(user: User, repo?: string): Role {
  if (user.role === "admin") return "admin";
  const own = repo === undefined ? undefined : user.repos[repo];
  if (own === undefined) return user.role;
  return own === "admin" ? "maintainer" : own;
}

/** Whether `user` may do `action` on `repo` (USR-1). No person, or a disabled one, may do nothing. */
export function can(user: User | null | undefined, action: Action, repo?: string): boolean {
  if (!user || user.disabled) return false;
  return roleRank(roleFor(user, repo)) >= roleRank(NEEDS[action]);
}

/** The reason a refused action gives (USR-7), or null when it is allowed. */
export function denial(user: User | null | undefined, action: Action, repo?: string): string | null {
  if (can(user, action, repo)) return null;
  const where = repo ? ` on ${repo}` : "";
  if (!user || user.disabled) return `you aren't signed in as a person who can ${action}${where}`;
  return `your role (${roleFor(user, repo)}) can't ${action}${where}`;
}
