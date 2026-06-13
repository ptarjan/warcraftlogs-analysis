// WCL GraphQL + Wowhead tooltips. Dual-mode:
//   browser -> the Cloudflare Worker proxy (hides the secret, adds CORS)
//   Node/CLI -> straight to WCL/Wowhead (the secret is safe locally and there's
//               no CORS), so the CLI needs NO Worker -- just credentials.
import { WORKER_URL, IS_NODE } from "./config.js";

export class PrivateReport extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Node direct-to-WCL path (no Worker) -------------------------------------
const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_API_URL = "https://www.warcraftlogs.com/api/v2/client";
const WOWHEAD = "https://nether.wowhead.com/tooltip/item/";
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

// Session-level dedupe: identical queries fired concurrently share one request
// (coalescing), and a resolved query is reused for the rest of the session.
// The analyses re-derive the same rankings/reports from several functions, so
// this cuts a large fraction of calls before they ever reach the Worker.
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
    let status, j;
    try {
      if (IS_NODE) {
        ({ status, j } = await nodeWcl(query));
      } else {
        const r = await fetch(`${WORKER_URL}/wcl`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        status = r.status;
        j = await r.json();
      }
    } catch (e) {
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
    // Honor HTTP 429 rate limits with exponential backoff -- several parallel
    // sessions share one API client's hourly point budget.
    if (status === 429 || (j.error && /too many requests/i.test(j.error))) {
      last = new Error(j.error || "rate limited (429)");
      await sleep(Math.min(90000, 10000 * 2 ** attempt));
      continue;
    }
    if (j.error) throw new Error(j.error); // other non-GraphQL error
    if (!j.data) throw new Error("no data: " + JSON.stringify(j).slice(0, 200));
    return j.data;
  }
  throw last;
}

// Wowhead tooltip JSON for an item (real per-instance stats need the bonus IDs).
// Coalesces concurrent identical fetches; the Worker also caches these for a
// week, so repeat lookups are effectively free.
const _itemInflight = new Map();
export async function itemTooltip(id, bonusIds) {
  const bonus = (bonusIds || []).map(String);
  const q = bonus.length ? `?bonus=${bonus.join(":")}` : "";
  const url = IS_NODE
    ? `${WOWHEAD}${encodeURIComponent(id)}${q}`
    : `${WORKER_URL}/item/${id}${q}`;
  if (_itemInflight.has(url)) return _itemInflight.get(url);
  const opts = IS_NODE ? { headers: { "User-Agent": "Mozilla/5.0" } } : undefined;
  const p = fetch(url, opts).then((r) => r.json());
  _itemInflight.set(url, p);
  try { return await p; } finally { _itemInflight.delete(url); }
}
