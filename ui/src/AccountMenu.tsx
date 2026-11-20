// The account menu (UI-223): who I am, my role, Telegram linking and sign-out. Only my own data.

import { useState } from "preact/hooks";
import { callJson, signOut } from "./api.ts";
import { loadMe, type Me } from "./session.ts";

export function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const repos = Object.entries(me.repoRoles);
  const link = async () => {
    const r = await callJson<{ ok: boolean; message?: string; code?: string; expiresInMinutes?: number }>(
      "/api/me/telegram",
      { op: "code" },
    );
    setCode(r.ok ? (r.code ?? null) : null);
    setNote(
      r.ok
        ? `Send it to the Towercab bot as “/link ${r.code}” within ${r.expiresInMinutes} minutes.`
        : (r.message ?? ""),
    );
  };
  const unlink = async () => {
    await callJson("/api/me/telegram", { op: "unlink" });
    setCode(null);
    setNote("");
    await loadMe();
  };
  const out = async () => {
    await signOut();
    await loadMe();
  };
  return (
    <div class="account">
      <button
        type="button"
        class="btn ghost account-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {me.name}
      </button>
      {open ? (
        <div class="account-menu" role="menu" aria-label="Account">
          <p class="account-who">
            <strong>{me.name}</strong>
            <span class="meta">@{me.login}</span>
          </p>
          <p class="meta">
            Role: <span data-testid="my-role">{me.role}</span>
            {repos.length ? ` (${repos.map(([r, role]) => `${role} on ${r}`).join(", ")})` : ""}
          </p>
          {me.telegram?.available ? (
            me.telegram.linked && !code ? (
              <p>
                <span>Telegram: Linked</span>{" "}
                <button type="button" class="link-btn" onClick={() => void unlink()}>
                  Unlink
                </button>
              </p>
            ) : (
              <div>
                <button type="button" class="btn" onClick={() => void link()}>
                  Link Telegram
                </button>
                {code ? (
                  <p class="telegram-code">
                    <code>{code}</code>
                  </p>
                ) : null}
                {note ? <p class="meta">{note}</p> : null}
              </div>
            )
          ) : null}
          <button type="button" class="btn ghost" role="menuitem" onClick={() => void out()}>
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
