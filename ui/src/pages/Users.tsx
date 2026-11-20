// The admin page (UI-222, UI-224): people, roles and repo access, the named team, sessions, settings and the
// history of changes. Every change is one call to `/api/users` or `/api/settings`; the server decides.

import { useState } from "preact/hooks";
import { callJson, useLive } from "../api.ts";
import { ErrorNote, Skeleton } from "../components.tsx";
import { SECURITY_NOTES } from "../users-notes.ts";

interface Person {
  login: string;
  name: string;
  role: string;
  repoRoles: Record<string, string>;
  disabled: boolean;
  addedBy: string;
  added: number;
  lastSeen: number | null;
}
interface SessionRow {
  hash: string;
  login: string;
  created: number;
  lastSeen: number;
}
interface UsersData {
  users: Person[];
  team: { team: string; role: string } | null;
  sessions: SessionRow[];
  events: { id: number; at: number; actor: string; what: string; login: string; detail: string }[];
}

const ROLES = ["viewer", "contributor", "maintainer", "admin"];
const TEAM_ROLES = ROLES.slice(0, 2);

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "never");

/** "web=maintainer, api=viewer" → `{web: "maintainer", api: "viewer"}`; an empty text is no repo roles. */
function parseRepoRoles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",")) {
    const [repo, role] = part.split("=").map((x) => x.trim());
    if (repo && role) out[repo] = role;
  }
  return out;
}
const showRepoRoles = (r: Record<string, string>) =>
  Object.entries(r)
    .map(([repo, role]) => `${repo}=${role}`)
    .join(", ");

export function UsersPage() {
  const live = useLive<UsersData>("/api/users");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState("viewer");
  const [repos, setRepos] = useState("");
  const [team, setTeam] = useState("");
  const [teamRole, setTeamRole] = useState("viewer");
  const [removing, setRemoving] = useState<string | null>(null);
  if (live.error && !live.data) return <ErrorNote text={live.error} />;
  if (!live.data) return <Skeleton />;
  const d = live.data;
  const call = async (path: string, body: Record<string, unknown>) => {
    const r = await callJson<{ ok: boolean; message?: string }>(path, body);
    setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Saved.") : (r.message ?? "That didn't work.") });
    return r.ok;
  };
  const users = (body: Record<string, unknown>) => call("/api/users", body);
  const add = async (e: Event) => {
    e.preventDefault();
    if (await users({ op: "add", login, role, repoRoles: parseRepoRoles(repos) })) {
      setLogin("");
      setRepos("");
    }
  };
  const sessionsOf = (l: string) => d.sessions.filter((s) => s.login.toLowerCase() === l.toLowerCase());
  return (
    <main class="page users-page" id="main">
      <h1>People</h1>
      {msg ? (
        <p class={msg.ok ? "meta" : "form-error"} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      ) : null}
      <table class="users-table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th>Repo roles</th>
            <th>Source</th>
            <th>Last seen</th>
            <th>Sessions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {d.users.map((u) => {
            const open = sessionsOf(u.login);
            return (
              <tr key={u.login} data-login={u.login} class={u.disabled ? "disabled" : undefined}>
                <td>
                  <strong>{u.name || u.login}</strong>
                  <span class="meta"> @{u.login}</span>
                  {u.disabled ? <span class="chip"> disabled</span> : null}
                </td>
                <td>
                  <select
                    aria-label={`Role of ${u.login}`}
                    value={u.role}
                    onChange={(e) =>
                      void users({
                        op: "change",
                        login: u.login,
                        role: (e.target as HTMLSelectElement).value,
                      })
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Repo roles of ${u.login}`}
                    placeholder="web=maintainer"
                    defaultValue={showRepoRoles(u.repoRoles)}
                    onChange={(e) =>
                      void users({
                        op: "change",
                        login: u.login,
                        repoRoles: parseRepoRoles((e.target as HTMLInputElement).value),
                      })
                    }
                  />
                </td>
                <td>{u.addedBy.startsWith("team:") ? `team ${u.addedBy.slice(5)}` : "added"}</td>
                <td>{when(u.lastSeen)}</td>
                <td>
                  {open.length ? (
                    <ul class="sessions">
                      {open.map((s) => (
                        <li key={s.hash}>
                          <span class="meta">
                            started {when(s.created)}, last seen {when(s.lastSeen)}
                          </span>{" "}
                          <button
                            type="button"
                            class="link-btn"
                            onClick={() => void users({ op: "revoke", hash: s.hash })}
                          >
                            Revoke
                          </button>
                        </li>
                      ))}
                      <li>
                        <button
                          type="button"
                          class="link-btn"
                          onClick={() => void users({ op: "revokeAll", login: u.login })}
                        >
                          Revoke all
                        </button>
                      </li>
                    </ul>
                  ) : (
                    <span class="meta">none</span>
                  )}
                </td>
                <td class="row-actions">
                  <button
                    type="button"
                    class="btn ghost"
                    onClick={() => void users({ op: u.disabled ? "enable" : "disable", login: u.login })}
                  >
                    {u.disabled ? "Enable" : "Disable"}
                  </button>
                  {removing === u.login ? (
                    <>
                      <button
                        type="button"
                        class="btn danger"
                        onClick={() =>
                          void users({ op: "remove", login: u.login }).then(() => setRemoving(null))
                        }
                      >
                        Yes, remove {u.login}
                      </button>
                      <button type="button" class="btn ghost" onClick={() => setRemoving(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" class="btn ghost" onClick={() => setRemoving(u.login)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <form class="users-add" onSubmit={(e) => void add(e)}>
        <h2>Add a person</h2>
        <label>
          GitHub login
          <input value={login} onInput={(e) => setLogin((e.target as HTMLInputElement).value)} required />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Repo roles
          <input
            value={repos}
            placeholder="web=maintainer, api=viewer"
            onInput={(e) => setRepos((e.target as HTMLInputElement).value)}
          />
        </label>
        <button type="submit" class="btn primary">
          Add person
        </button>
      </form>

      <section class="users-team">
        <h2>GitHub team</h2>
        <p class="meta">
          {d.team
            ? `Members of ${d.team.team} sign in as ${d.team.role}.`
            : "No team named: only added people sign in."}
        </p>
        <label>
          Team (org/team)
          <input value={team} onInput={(e) => setTeam((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Role
          <select
            aria-label="Team role"
            value={teamRole}
            onChange={(e) => setTeamRole((e.target as HTMLSelectElement).value)}
          >
            {TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button type="button" class="btn" onClick={() => void users({ op: "team", team, role: teamRole })}>
          Save team
        </button>
        {d.team ? (
          <button type="button" class="btn ghost" onClick={() => void users({ op: "team", team: "" })}>
            Clear team
          </button>
        ) : null}
      </section>

      <section class="users-settings">
        <h2>Settings</h2>
        <BudgetSetting label="Daily budget (USD)" keyName="agent.daily_budget_usd" call={call} />
        <BudgetSetting label="Monthly budget (USD)" keyName="agent.monthly_budget_usd" call={call} />
        <h3>Security settings</h3>
        <ul class="security-settings">
          {SECURITY_NOTES.map((n) => (
            <li key={n}>
              {n} <span class="meta">Edit the config file.</span>
            </li>
          ))}
        </ul>
      </section>

      <section class="users-history">
        <h2>History</h2>
        <ul>
          {d.events.map((e) => (
            <li key={e.id}>
              <span class="meta">{when(e.at)}</span> {e.actor}: {e.what}
              {e.login ? ` ${e.login}` : ""}
              {e.detail ? ` (${e.detail})` : ""}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function BudgetSetting({
  label,
  keyName,
  call,
}: {
  label: string;
  keyName: string;
  call(path: string, body: Record<string, unknown>): Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      class="setting-row"
      onSubmit={(e) => {
        e.preventDefault();
        void call("/api/settings", { key: keyName, value: Number(value) });
      }}
    >
      <label>
        {label}
        <input
          type="number"
          min="0"
          step="any"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        />
      </label>
      <button type="submit" class="btn">
        Save
      </button>
    </form>
  );
}
