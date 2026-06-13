// WCL GraphQL + Wowhead tooltips. Three paths, no secret in the page:
//   Node/CLI       -> client-credentials (env/.env) -> /api/v2/client, direct.
//   browser, anon  -> the Cloudflare Worker proxy (holds the shared secret).
//   browser, conn  -> the user's own PKCE token (auth.js) -> /api/v2/user, direct.
// "conn" wins when a token is present; otherwise we fall back to the proxy.
import {
  IS_NODE, TOKEN_URL, CLIENT_API_URL, USER_API_URL, WOWHEAD_URL,
  WORKER_URL, WORKER_CONFIGURED,
} from "./config.js";
import { getAccessToken, logout } from "./auth.js";

export class PrivateReport extends Error {}

// Raised when the browser has no valid token (or it expired). Callers catch this
// to send the user through the connect flow instead of showing a network error.
export class NeedsAuth extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Node direct-to-WCL path (client-credentials) ----------------------------
const WCL_TOKEN_URL = TOKEN_URL;
const WCL_API_URL = CLIENT_API_URL;
const WOWHEAD = WOWHEAD_URL;
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
  const r = await fetch(WCL_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
               "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  const j = await r.json();
  _nodeToken = { t: j.access_token, exp: now + (j.expires_in || 0) };
  return _nodeToken.t;
}

async function nodeWcl(query) {
  const token = await nodeToken();
  const r = await fetch(WCL_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

// Reset hint (seconds) WCL / the Worker may send on a 429, for the UI countdown.
const readRetryAfter = (r) => {
  const n = parseInt(r.headers.get("Retry-After") || "", 10);
  return Number.isFinite(n) ? n : null;
};

// ---- Browser path: own PKCE token if connected, else the anonymous proxy ------
async function browserWcl(query) {
  const token = getAccessToken();
  if (token) {
    const r = await fetch(USER_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    // A connected user whose token died must reconnect (or disconnect to use the
    // shared proxy). Clear the dead token so the UI/next load reflect it; we don't
    // silently fall back, so the active identity stays honest.
    if (r.status === 401) {
      logout();
      throw new NeedsAuth("Your Warcraft Logs session expired -- reconnect, or disconnect to use the shared proxy.");
    }
    return { status: r.status, j: await r.json().catch(() => ({})), retryAfter: readRetryAfter(r) };
  }
  // Anonymous: route through the Worker, which holds the shared app secret.
  if (!WORKER_CONFIGURED)
    throw new NeedsAuth("Connect your Warcraft Logs account to run the analysis (no proxy is configured).");
  const r = await fetch(`${WORKER_URL}/wcl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return { status: r.status, j: await r.json().catch(() => ({})), retryAfter: readRetryAfter(r) };
}

// Session-level dedupe: identical queries fired concurrently share one request
// (coalescing), and a resolved query is reused for the rest of the session.
// The analyses re-derive the same rankings/reports from several functions, so
// this cuts a large fraction of calls before they ever leave the browser.
const _gqlInflight = new Map();
const _gqlCache = new Map();

export function clearGqlCache() { _gqlCache.clear(); }

export async function gql(query, retries = 6) {
  if (_gqlCache.has(query)) return _gqlCache.get(query);
  if (_gqlInflight.has(query)) return _gqlInflight.get(query);
  const p = _gqlRun(query, retries);
  _gqlInflight.set(query, p);
  try {
    const data = await p;
    _gqlCache.set(query, data);
    return data;
  } finally {
    _gqlInflight.delete(query);
  }
}

// Run a GraphQL query, returning the parsed `data`. Retries transient errors;
// throws PrivateReport on permission errors so callers can skip a report.
async function _gqlRun(query, retries = 6) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    let status, j, retryAfter = null;
    try {
      ({ status, j, retryAfter } = IS_NODE ? await nodeWcl(query) : await browserWcl(query));
    } catch (e) {
      if (e instanceof NeedsAuth) throw e; // don't retry -- the user must reconnect
      // Network/transport failure -- worth retrying with backoff.
      last = e;
      await sleep(1000 * (2 + attempt));
      continue;
    }
    if (j.errors) {
      const msg = JSON.stringify(j.errors);
      if (msg.includes("permission") || msg.includes("do not have")) throw new PrivateReport(msg);
      throw new Error(msg);
    }
    // Rate limited: the Worker already absorbed transient 429s server-side, so a
    // 429 here means a sustained limit (shared hourly budget across all users).
    // Signal the UI and back off briefly, then give up with a clear message
    // rather than hanging silently for minutes.
    if (status === 429 || (j.error && /too many requests/i.test(j.error))) {
      last = new Error("WCL is rate-limiting the app right now (one hourly budget is shared by everyone). Try again in a few minutes.");
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wcl-ratelimit", { detail: { retryAfter } }));
      await sleep(retryAfter ? Math.min(20000, retryAfter * 1000) : Math.min(12000, 2000 * 2 ** attempt));
      continue;
    }
    if (j.error) throw new Error(j.error); // other non-GraphQL error
    if (!j.data) throw new Error("no data: " + JSON.stringify(j).slice(0, 200));
    return j.data;
  }
  throw last;
}

// Wowhead tooltip JSON for an item (real per-instance stats need the bonus IDs).
// Direct to Wowhead when trusted (Node) or connected (own token); anonymous
// browser sessions go through the Worker (which also caches these for a week).
// Coalesces concurrent identical fetches within a session.
const _itemInflight = new Map();
export async function itemTooltip(id, bonusIds) {
  const bonus = (bonusIds || []).map(String);
  const q = bonus.length ? `?bonus=${bonus.join(":")}` : "";
  const direct = IS_NODE || !!getAccessToken();
  const url = direct
    ? `${WOWHEAD}${encodeURIComponent(id)}${q}`
    : `${WORKER_URL}/item/${id}${q}`;
  if (_itemInflight.has(url)) return _itemInflight.get(url);
  // Node has no default UA Wowhead likes; the browser sends its own (and can't
  // override it anyway), so only set it under Node.
  const opts = IS_NODE ? { headers: { "User-Agent": "Mozilla/5.0" } } : undefined;
  const p = fetch(url, opts).then((r) => r.json());
  _itemInflight.set(url, p);
  try { return await p; } finally { _itemInflight.delete(url); }
}

// The connected user's own characters that have parses on the CURRENT content,
// most parses first. "Parses" = ranked kills in the current zone (zoneRankings
// defaults to the current zone), summed across Mythic + Heroic. Connected-only
// and best-effort with a two-tier fallback: if the ranking shape isn't available
// we return the bare list (unsorted) so the picker still works; on any miss, [].
export async function myCharacters() {
  if (IS_NODE || !getAccessToken()) return [];
  const loc = "name server { slug region { slug } }";
  // zoneRankings is a JSON scalar: { rankings: [{ totalKills, rankPercent, ... }] }.
  const parsesIn = (zr) => ((zr && zr.rankings) || [])
    .reduce((n, r) => n + (r && r.rankPercent != null ? (r.totalKills || 0) : 0), 0);

  for (const [sel, ranked] of [
    [`${loc} m: zoneRankings(difficulty: 5) h: zoneRankings(difficulty: 4)`, true],
    [loc, false], // fallback: bare list (no counts) if zoneRankings isn't usable
  ]) {
    let raw;
    try {
      const d = await gql(`{ userData { currentUser { characters { ${sel} } } } }`);
      raw = (d && d.userData && d.userData.currentUser && d.userData.currentUser.characters) || [];
    } catch { continue; } // bad field / no permission -> try the simpler shape
    let chars = raw
      .map((c) => ({
        name: c.name,
        server: c.server && c.server.slug,
        region: ((c.server && c.server.region && c.server.region.slug) || "").toUpperCase(),
        parses: ranked ? parsesIn(c.m) + parsesIn(c.h) : 0,
      }))
      .filter((c) => c.name && c.server && c.region);
    // Keep only characters with current-content parses, most first. Guard: if the
    // shape unexpectedly yields 0 for everyone, don't hide them all -- show the list.
    if (ranked && chars.some((c) => c.parses > 0))
      chars = chars.filter((c) => c.parses > 0).sort((a, b) => b.parses - a.parses);
    return chars;
  }
  return [];
}
