// GitHub's OAuth web flow for sign-in (USR-3). The login is read from the API with the user's own token,
// never from the browser. Everything goes through an injected `Http`, so tests never reach GitHub.

import { HTTP_TIMEOUT_MS, type Http } from "./app.ts";

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  /** `<public_url>/api/auth/callback`. */
  redirectUri: string;
  /** Where GitHub's sign-in pages are; a GitHub Enterprise host changes it. */
  webBase?: string;
  apiBase?: string;
}

const WEB = "https://github.com";
const API = "https://api.github.com";

/** The page people are sent to. Asks for no scope: the login and the team check need none beyond the App's. */
export function authorizeUrl(app: OAuthApp, state: string): string {
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: app.redirectUri, state });
  return `${app.webBase ?? WEB}/login/oauth/authorize?${q}`;
}

const json = (text: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Trades the one-time `code` for the user's token. The reason GitHub gives is the error's message. */
export async function exchangeCode(http: Http, app: OAuthApp, code: string): Promise<string> {
  const r = await http({
    method: "POST",
    url: `${app.webBase ?? WEB}/login/oauth/access_token`,
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: app.redirectUri,
    }),
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  const b = json(r.text);
  if (r.status !== 200 || typeof b.access_token !== "string" || !b.access_token) {
    const why = typeof b.error_description === "string" ? b.error_description : `GitHub answered ${r.status}`;
    throw new Error(`GitHub refused the sign-in code: ${why}`);
  }
  return b.access_token;
}

const authHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
});

/** USR-3: who the token belongs to, from `GET /user`. */
export async function fetchLogin(http: Http, app: OAuthApp, token: string): Promise<string> {
  const r = await http({
    method: "GET",
    url: `${app.apiBase ?? API}/user`,
    headers: authHeaders(token),
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  const login = json(r.text).login;
  if (r.status !== 200 || typeof login !== "string" || !login) {
    throw new Error(`GitHub didn't say who you are (it answered ${r.status})`);
  }
  return login;
}

/**
 * USR-2: whether the token's owner is an active member of `org/team`. A 404 means no; any other failure
 * throws, so a missing "Members: read" permission shows as a problem and not as "not a member".
 */
export async function inTeam(http: Http, app: OAuthApp, token: string, team: string, login: string) {
  const [org, slug] = team.split("/");
  const r = await http({
    method: "GET",
    url: `${app.apiBase ?? API}/orgs/${org}/teams/${slug}/memberships/${login}`,
    headers: authHeaders(token),
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  if (r.status === 404) return false;
  if (r.status === 200) return json(r.text).state === "active";
  throw new Error(
    `couldn't check the team ${team} (GitHub answered ${r.status}): the App needs the "Members: read" organisation permission`,
  );
}
