// OAuth 2.0 PKCE ("public client") for the browser -- no client secret. On the
// way out we send a SHA-256 code *challenge*; on the token exchange we send the
// matching *verifier*, proving we started the flow. The access token lives in
// localStorage; when it expires (or a 401 comes back) we just send the user
// through authorize again.
//
// Imported only by the browser. Every browser global (localStorage, crypto,
// location, fetch) is touched INSIDE a function, so this module also imports
// cleanly under Node -- the CLI never calls any of it.
import { CLIENT_ID, AUTHORIZE_URL, TOKEN_URL, REDIRECT_URI } from "./config.js";

const TOKEN_KEY = "wclToken";          // { access_token, expires_at }
const VERIFIER_KEY = "wclPkceVerifier"; // outstanding flow's code_verifier
const STATE_KEY = "wclPkceState";       // outstanding flow's anti-CSRF state
const RETURN_KEY = "wclReturn";         // caller state to resume after redirect

// Base64url (no padding) of an ArrayBuffer/Uint8Array.
function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A high-entropy URL-safe string for the PKCE verifier / state (RFC 7636: the
// verifier must be 43-128 chars from the unreserved set; base64url qualifies).
function randomString(len = 64) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return b64url(a).slice(0, len);
}

// The S256 code challenge for a verifier. Exported for testing (RFC 7636 vector).
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}

// The current valid access token, or null. A 60s skew margin avoids handing out
// a token that dies mid-request.
export function getAccessToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (t && t.access_token && t.expires_at > Date.now() / 1000 + 60) return t.access_token;
  } catch { /* corrupt entry -- treat as logged out */ }
  return null;
}

export function isAuthed() { return !!getAccessToken(); }

export function logout() { localStorage.removeItem(TOKEN_KEY); }

// Kick off the authorization redirect. `returnState` (optional, JSON-able) is
// stashed and handed back by handleRedirectCallback() after the round-trip, so
// the caller can resume what the user was doing (e.g. re-run their analysis).
export async function beginLogin(returnState) {
  if (!CLIENT_ID || CLIENT_ID.startsWith("PASTE_"))
    throw new Error("No WCL client id configured -- set CLIENT_ID in docs/config.js.");
  const verifier = randomString(64);
  const state = randomString(24);
  localStorage.setItem(VERIFIER_KEY, verifier);
  localStorage.setItem(STATE_KEY, state);
  if (returnState !== undefined)
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(returnState));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state,
  });
  location.assign(`${AUTHORIZE_URL}?${params}`);
}

// Call once on page load. If we returned from authorize with ?code&state:
// verify state, exchange the code for a token, store it, strip the query so a
// refresh can't replay the code, and return { token, returnState }. Returns
// null when this isn't an OAuth callback. Throws on a real authorization error.
export async function handleRedirectCallback() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (!code && !err) return null;

  // Always clean the URL first, so a reload doesn't re-trigger this.
  history.replaceState(null, "", url.origin + url.pathname);

  if (err)
    throw new Error(`Authorization failed: ${url.searchParams.get("error_description") || err}`);

  const expected = localStorage.getItem(STATE_KEY);
  const verifier = localStorage.getItem(VERIFIER_KEY);
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(VERIFIER_KEY);
  if (!state || state !== expected)
    throw new Error("Authorization state mismatch -- please connect again.");
  if (!verifier)
    throw new Error("Missing PKCE verifier -- please connect again.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: verifier,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok)
    throw new Error(`Token exchange failed (${r.status}) -- check the client id and redirect URL.`);
  const j = await r.json();
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: j.access_token,
    expires_at: Date.now() / 1000 + (j.expires_in || 0),
  }));

  let returnState = null;
  try { returnState = JSON.parse(sessionStorage.getItem(RETURN_KEY) || "null"); } catch { /* ignore */ }
  sessionStorage.removeItem(RETURN_KEY);
  return { token: j.access_token, returnState };
}
