// The sign-in screen (UI-219): one button, and why a refused account was refused.

import { signOut } from "./api.ts";
import { loadMe } from "./session.ts";

export function SignIn({ expired }: { expired: boolean }) {
  const q = new URLSearchParams(location.search);
  const error = q.get("error");
  const login = q.get("login");
  const out = async () => {
    await signOut();
    history.replaceState(null, "", "/signin");
    await loadMe();
  };
  return (
    <main class="signin" id="main">
      <h1>Towercab</h1>
      {error ? (
        <div class="signin-note error" role="alert">
          <p>{error}</p>
          {login ? (
            <p class="meta">
              You signed in as <strong>{login}</strong>.{" "}
              <button type="button" class="link-btn" onClick={() => void out()}>
                Sign out
              </button>
            </p>
          ) : null}
        </div>
      ) : expired ? (
        <p class="signin-note" role="status">
          You were signed out.
        </p>
      ) : null}
      <a class="btn primary" href="/api/auth/login">
        Sign in with GitHub
      </a>
    </main>
  );
}
