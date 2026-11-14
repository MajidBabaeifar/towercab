// UI-222, UI-224: people, roles, repo access, settings, history and sessions. Admins only.

import { useState } from "preact/hooks";
import { postJson, useLive } from "../api.ts";
import { ErrorNote, Skeleton } from "../components.tsx";

const ROLES = ["viewer", "contributor", "maintainer", "admin"];
const TEAM_ROLES = ["viewer", "contributor"];

interface Session {
  id: number;
  login: string;
  created: number;
  lastSeen: number;
}
interface Person {
  login: string;
  name: string;
  role: string;
  repos: Record<string, string>;
  disabled: boolean;
  source: string;
  lastSeen: number | null;
  sessions: Session[];
}
interface UsersData {
  people: Person[];
  team: { name: string; role: string } | null;
  repos: string[];
  events: { id: number; at: number; actor: string; action: string; target: string; detail: string }[];
  current: number;
}
interface SettingsData {
  editable: { key: string; value: string | number | boolean | null; kind: string }[];
  security: { key: string; value: string }[];
  note: string;
}

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : "never");
const reposText = (r: Record<string, string>) =>
  Object.entries(r)
    .map(([k, v]) => `${v} on ${k}`)
    .join(", ") || "none";

function AddPerson({ repos, say }: { repos: string[]; say(m: string): void }) {
  const [login, setLogin] = useState("");
  const [role, setRole] = useState("viewer");
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [repo, setRepo] = useState("");
  const [repoRole, setRepoRole] = useState("maintainer");
  return (
    <form
      class="admin-add"
      aria-label="Add a person"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await postJson("/api/users", { op: "add", login, role, repos: pairs });
        say(r.message ?? "");
        if (r.ok) {
          setLogin("");
          setPairs({});
        }
      }}
    >
      <h3>Add a person</h3>
      <label>
        GitHub login
        <input name="login" value={login} onInput={(e) => setLogin((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Default role
        <select name="role" value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
          {ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Role on one repo</legend>
        <select
          name="repo"
          aria-label="Repo"
          value={repo}
          onChange={(e) => setRepo((e.target as HTMLSelectElement).value)}
        >
          <option value="">Pick a repo</option>
          {repos.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <select
          name="repo-role"
          aria-label="Role on that repo"
          value={repoRole}
          onChange={(e) => setRepoRole((e.target as HTMLSelectElement).value)}
        >
          {ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <button
          type="button"
          class="btn ghost"
          disabled={!repo}
          onClick={() => setPairs({ ...pairs, [repo]: repoRole })}
        >
          Set repo role
        </button>
        <span class="meta">{Object.keys(pairs).length ? reposText(pairs) : null}</span>
      </fieldset>
      <button type="submit" class="btn primary" disabled={!login.trim()}>
        Add person
      </button>
    </form>
  );
}

function PersonRow({ p, d, say }: { p: Person; d: UsersData; say(m: string): void }) {
  const [confirm, setConfirm] = useState(false);
  const op = async (body: Record<string, unknown>) => {
    const r = await postJson("/api/users", { login: p.login, ...body });
    say(r.message ?? "");
  };
  return (
    <tr data-login={p.login} class={p.disabled ? "disabled" : undefined}>
      <td>
        <strong>{p.name || p.login}</strong>
        <br />
        <span class="meta">@{p.login}</span>
      </td>
      <td>
        <select
          aria-label={`Role of ${p.login}`}
          value={p.role}
          onChange={(e) => void op({ op: "change", role: (e.target as HTMLSelectElement).value })}
        >
          {ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </td>
      <td>
        {Object.entries(p.repos).map(([repo, role]) => (
          <span class="chip" key={repo}>
            {role} on {repo}
          </span>
        ))}
        {Object.keys(p.repos).length ? null : <span class="meta">none</span>}
      </td>
      <td>{p.source}</td>
      <td>{when(p.lastSeen)}</td>
      <td>
        {p.sessions.map((s) => (
          <div class="session" key={s.id}>
            <span class="meta">
              started {when(s.created)}, seen {when(s.lastSeen)}
              {s.id === d.current ? " (this one)" : ""}
            </span>{" "}
            <button type="button" class="btn ghost" onClick={() => void op({ op: "revoke", session: s.id })}>
              Revoke
            </button>
          </div>
        ))}
        {p.sessions.length > 1 ? (
          <button type="button" class="btn ghost" onClick={() => void op({ op: "revoke-all" })}>
            Revoke all
          </button>
        ) : null}
        {p.sessions.length ? null : <span class="meta">none</span>}
      </td>
      <td>
        <button
          type="button"
          class="btn ghost"
          onClick={() => void op({ op: p.disabled ? "enable" : "disable" })}
        >
          {p.disabled ? "Enable" : "Disable"}
        </button>
        {confirm ? (
          <span role="alertdialog" aria-label={`Remove ${p.login}`}>
            Remove {p.login}?{" "}
            <button
              type="button"
              class="btn danger"
              onClick={async () => {
                await op({ op: "remove" });
                setConfirm(false);
              }}
            >
              Yes, remove
            </button>
            <button type="button" class="btn ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" class="btn ghost" onClick={() => setConfirm(true)}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

function Team({ d, say }: { d: UsersData; say(m: string): void }) {
  const [name, setName] = useState(d.team?.name ?? "");
  const [role, setRole] = useState(d.team?.role ?? "viewer");
  return (
    <section class="admin-team">
      <h3>GitHub team</h3>
      <p class="meta">Members of this team can sign in with the role below (at most contributor).</p>
      <label>
        Team (org/team)
        <input name="team" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <select
        aria-label="Team role"
        name="team-role"
        value={role}
        onChange={(e) => setRole((e.target as HTMLSelectElement).value)}
      >
        {TEAM_ROLES.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
      <button
        type="button"
        class="btn ghost"
        onClick={async () => {
          const r = await postJson("/api/users", { op: "team", team: name.trim() || null, role });
          say(r.message ?? "");
        }}
      >
        Save team
      </button>
    </section>
  );
}

function SettingRow({ s, say }: { s: SettingsData["editable"][number]; say(m: string): void }) {
  const [v, setV] = useState(String(s.value ?? ""));
  const save = async () => {
    const value =
      s.kind === "int" ? Number(v) : s.kind === "bool" ? v === "true" : s.kind === "budget" ? Number(v) : v;
    const r = await postJson("/api/settings", { changes: { [s.key]: value } });
    say(r.message ?? "");
  };
  return (
    <div data-setting={s.key}>
      <dt>{s.key}</dt>
      <dd>
        <input aria-label={s.key} value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
        <button type="button" class="btn ghost" onClick={() => void save()}>
          Save
        </button>
      </dd>
    </div>
  );
}

function Settings({ say }: { say(m: string): void }) {
  const live = useLive<SettingsData>("/api/settings");
  if (!live.data) return live.error ? <ErrorNote text={live.error} /> : null;
  return (
    <section class="admin-settings">
      <h3>Settings</h3>
      <dl>
        {live.data.editable.map((s) => (
          <SettingRow key={s.key} s={s} say={say} />
        ))}
      </dl>
      <h4>Security settings</h4>
      <p class="meta">{live.data.note} Edit the config file.</p>
      <dl class="readonly">
        {live.data.security.map((s) => (
          <div key={s.key} data-security={s.key}>
            <dt>{s.key}</dt>
            <dd>{s.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AdminPage() {
  const live = useLive<UsersData>("/api/users");
  const [note, setNote] = useState("");
  if (live.error && !live.data) return <ErrorNote text={live.error} />;
  if (!live.data) return <Skeleton />;
  const d = live.data;
  return (
    <main class="page admin" id="main">
      <h1>People</h1>
      {note ? (
        <p class="admin-note" role="status">
          {note}
        </p>
      ) : null}
      <table class="people">
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
          {d.people.map((p) => (
            <PersonRow key={p.login} p={p} d={d} say={setNote} />
          ))}
        </tbody>
      </table>
      <AddPerson repos={d.repos} say={setNote} />
      <Team d={d} say={setNote} />
      <Settings say={setNote} />
      <section class="admin-history">
        <h3>History</h3>
        <ul>
          {d.events.map((e) => (
            <li key={e.id}>
              <span class="meta">{when(e.at)}</span> {e.actor} {e.action} {e.target}
              {e.detail ? ` (${e.detail})` : ""}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
