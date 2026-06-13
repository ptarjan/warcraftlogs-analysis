// PKCE helpers: the code challenge must match the RFC 7636 test vector (a wrong
// base64url/digest silently breaks the OAuth round-trip), and token storage must
// honor expiry so we never hand out a dead token.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();

test("pkceChallenge matches the RFC 7636 S256 test vector", async () => {
  const { pkceChallenge } = await import("../docs/auth.js");
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(await pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("getAccessToken honors expiry; logout clears it", async () => {
  const { getAccessToken, isAuthed, logout } = await import("../docs/auth.js");
  const now = Date.now() / 1000;

  assert.equal(getAccessToken(), null, "no token -> null");
  assert.equal(isAuthed(), false);

  localStorage.setItem("wclToken", JSON.stringify({ access_token: "live", expires_at: now + 600 }));
  assert.equal(getAccessToken(), "live", "valid token returned");
  assert.equal(isAuthed(), true);

  localStorage.setItem("wclToken", JSON.stringify({ access_token: "dead", expires_at: now - 10 }));
  assert.equal(getAccessToken(), null, "expired token treated as absent");

  localStorage.setItem("wclToken", JSON.stringify({ access_token: "live2", expires_at: now + 600 }));
  logout();
  assert.equal(getAccessToken(), null, "logout clears the token");
});
