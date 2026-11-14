// UI-219: the sign-in screen, shown when Towercab has people set up and there is no session.

import { Logo } from "./icons.tsx";

export function SignIn({ was }: { was: boolean }) {
  return (
    <main class="page signin" id="main">
      <Logo size={40} />
      <h1>Towercab</h1>
      {was ? (
        <p class="signin-note" role="status">
          You were signed out.
        </p>
      ) : null}
      <p>
        <a class="btn primary" href="/auth/login">
          Sign in with GitHub
        </a>
      </p>
    </main>
  );
}
