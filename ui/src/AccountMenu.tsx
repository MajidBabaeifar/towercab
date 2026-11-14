// UI-223: who I am, my role, Telegram and sign-out.

import { useState } from "preact/hooks";
import { postJson } from "./api.ts";
import { loadMe, type Me, signedOut } from "./me.ts";

interface Link {
  ok: boolean;
  message?: string;
  code?: string;
  minutes?: number;
}

export function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<Link | null>(null);
  const repos = Object.entries(me.repos);
  const telegram = async (op: "link" | "unlink") => {
    const r = await postJson<Link>("/api/me/telegram", { op });
    setCode(op === "link" && r.ok ? r : null);
    await loadMe();
  };
  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } });
    signedOut();
  };
  return (
    <div class="account">
      <button
        type="button"
        class="btn ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {me.name}
      </button>
      {open ? (
        <div class="menu account-menu" role="menu">
          <p>
            <strong>{me.name}</strong>
            <br />
            <span class="meta">@{me.login}</span>
          </p>
          <p class="account-role">
            Role: <strong>{me.role}</strong>
            {repos.length ? (
              <span class="meta">{` · ${repos.map(([r, role]) => `${role} on ${r}`).join(", ")}`}</span>
            ) : null}
          </p>
          {me.telegram ? (
            <p>
              Telegram: Linked{" "}
              <button type="button" class="link-btn" onClick={() => void telegram("unlink")}>
                Unlink
              </button>
            </p>
          ) : (
            <p>
              <button type="button" class="link-btn" onClick={() => void telegram("link")}>
                Link Telegram
              </button>
            </p>
          )}
          {code?.code ? (
            <p class="telegram-code" role="status">
              Send <code>{code.code}</code> to the Towercab bot within {code.minutes ?? 10} minutes.
            </p>
          ) : null}
          <p>
            <button type="button" class="link-btn" onClick={() => void signOut()}>
              Sign out
            </button>
          </p>
        </div>
      ) : null}
    </div>
  );
}
