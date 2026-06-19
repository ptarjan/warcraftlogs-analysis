// @ts-check
// The WCL HTTP transport: how to make ONE authenticated GraphQL request, on either path.
//   - Node (CLI): client-credentials token (from env/.env/worker .dev.vars) -> /api/v2/client.
//   - browser: the user's own PKCE token (auth.js) -> /api/v2/user.
// No caching, batching, or retry here -- wcl.js's gql() owns that and calls nodeWcl/browserWcl.
// A leaf module (imports only config + auth), so wcl.js depends on it with no cycle.
import { TOKEN_URL, CLIENT_API_URL, USER_API_URL } from "./config.js";
import { getAccessToken, logout, NeedsAuth } from "./auth.js";

const HTTP_TIMEOUT_MS = 45000;
// Every WCL/Wowhead fetch gets a timeout so a hung socket can't wedge a whole run.
export const withTimeout = (opts = {}) => ({ ...opts, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });

// Reset hint (seconds) WCL / the Worker may send on a 429, for the UI countdown.
const readRetryAfter = (r) => {
  const n = parseInt(r.headers.get("Retry-After") || "", 10);
  return Number.isFinite(n) ? n : null;
};

// ---- Node path: client-credentials (the CLI) --------------------------------
let _nodeToken = null;
async function nodeCreds() {
  let id = process.env.WCL_CLIENT_ID, secret = process.env.WCL_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  // Fall back to .env / worker/.dev.vars next to the repo (gitignored).
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../worker/.dev.vars", "../.env"]) {
    try {
      for (const line of fs.readFileSync(path.join(dir, rel), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const v = m[2].replace(/^["']|["']$/g, "");
        if (m[1] === "WCL_CLIENT_ID") id = id || v;
        if (m[1] === "WCL_CLIENT_SECRET") secret = secret || v;
      }
    } catch { /* file absent -- try the next */ }
  }
  if (!id || !secret)
    throw new Error("Missing WCL_CLIENT_ID / WCL_CLIENT_SECRET (env, .env, or worker/.dev.vars)");
  return { id, secret };
}

async function nodeToken() {
  const now = Date.now() / 1000;
  if (_nodeToken && _nodeToken.exp > now + 60) return _nodeToken.t;
  const { id, secret } = await nodeCreds();
  const r = await fetch(TOKEN_URL, withTimeout({
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
               "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  }));
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  const j = await r.json();
  _nodeToken = { t: j.access_token, exp: now + (j.expires_in || 0) };
  return _nodeToken.t;
}

export async function nodeWcl(query) {
  const token = await nodeToken();
  const r = await fetch(CLIENT_API_URL, withTimeout({
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }));
  // Read Retry-After like the browser path so the CLI's 429 message can say WHEN
  // the budget resets (it talks direct to WCL, which sends the header) instead of
  // the vague "try again shortly".
  return { status: r.status, j: await r.json().catch(() => ({})), retryAfter: readRetryAfter(r) };
}

// ---- Browser path: the user's own PKCE token (connect-only) -------------------
export async function browserWcl(query) {
  const token = getAccessToken();
  if (!token) throw new NeedsAuth("Connect your Warcraft Logs account to run the analysis.");
  const r = await fetch(USER_API_URL, withTimeout({
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }));
  // A dead/expired token must reconnect; clear it so the UI reflects the change.
  if (r.status === 401) {
    logout();
    throw new NeedsAuth("Your Warcraft Logs session expired -- reconnect to continue.");
  }
  return { status: r.status, j: await r.json().catch(() => ({})), retryAfter: readRetryAfter(r) };
}
