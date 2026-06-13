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

// Abort a request that hangs on a dead socket instead of freezing forever (a
// no-timeout fetch once stalled a CLI run for 26 minutes). An abort surfaces as
// a thrown error, which the gql retry loop treats as a transient transport
// failure and retries with backoff.
const HTTP_TIMEOUT_MS = 45000;
const withTimeout = (opts = {}) => ({ ...opts, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });

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
  const r = await fetch(WCL_TOKEN_URL, withTimeout({
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

async function nodeWcl(query) {
  const token = await nodeToken();
  const r = await fetch(WCL_API_URL, withTimeout({
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }));
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
    const r = await fetch(USER_API_URL, withTimeout({
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    }));
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
  const r = await fetch(`${WORKER_URL}/wcl`, withTimeout({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }));
  return { status: r.status, j: await r.json().catch(() => ({})), retryAfter: readRetryAfter(r) };
}

// Session-level dedupe: identical queries fired concurrently share one request
// (coalescing), and a resolved query is reused for the rest of the session.
// The analyses re-derive the same rankings/reports from several functions, so
// this cuts a large fraction of calls before they ever leave the browser.
const _gqlInflight = new Map();
const _gqlCache = new Map();

// --- Persistent (cross-reload) query cache -----------------------------------
// The in-memory cache above dies on refresh; on the connected path that means a
// reload re-spends the user's own quota. So also stash successful results in
// localStorage with a 1h TTL (WCL rankings/reports are static enough within the
// hour -- the same window the Worker uses). Browser only: the CLI/tests keep the
// in-memory cache so their behavior is unchanged. Every storage access is
// wrapped -- a failure (quota, private mode) just falls through to the network.
const PERSIST = !IS_NODE;
const LS_PREFIX = "gqlc:";
const LS_TTL = 60 * 60 * 1000;     // 1 hour
const LS_MAX_ENTRY = 400 * 1024;   // skip persisting responses bigger than ~400 KB

// Short, stable key from the query text (FNV-1a). Collisions are made safe by
// storing the query alongside the value and verifying it on read.
function _hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return LS_PREFIX + (h >>> 0).toString(36);
}

// Exported for tests. Read returns undefined on miss / stale / collision / error.
export function _cacheRead(query) {
  try {
    const raw = localStorage.getItem(_hash(query));
    if (!raw) return undefined;
    const e = JSON.parse(raw);
    if (e.q !== query || Date.now() - e.t > LS_TTL) return undefined;
    return e.d;
  } catch { return undefined; }
}
export function _cacheWrite(query, data) {
  let raw;
  try { raw = JSON.stringify({ q: query, t: Date.now(), d: data }); } catch { return; }
  if (raw.length > LS_MAX_ENTRY) return; // memory cache still holds it for this session
  const key = _hash(query);
  for (let i = 0; i < 4; i++) {
    try { localStorage.setItem(key, raw); return; }
    catch { if (!_evictOldest()) return; } // quota: drop oldest 25% and retry
  }
}
// Drop the oldest ~quarter of persisted queries. Returns false when there's
// nothing left to evict, so the caller stops retrying.
function _evictOldest() {
  try {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX)) continue;
      let t = 0; try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch { /* keep 0 */ }
      items.push([k, t]);
    }
    if (!items.length) return false;
    items.sort((a, b) => a[1] - b[1]);
    for (let i = 0, n = Math.max(1, items.length >> 2); i < n; i++) localStorage.removeItem(items[i][0]);
    return true;
  } catch { return false; }
}

export function clearGqlCache() { _gqlCache.clear(); }

// ---- Node-only on-disk cache -------------------------------------------------
// The browser path is already cached by the Worker (shared, keyed by query
// hash). Node talks straight to WCL, so without this every CLI run re-fetches
// everything and back-to-back runs trip WCL's per-IP 429 throttle. Persisting
// successful GraphQL results between runs makes iterating ~free. No effect in
// the browser (guarded by IS_NODE; node:* imports are dynamic).
const DISK_TTL_MS = 6 * 60 * 60 * 1000; // logs are immutable; rankings drift slowly
let _diskReady = null;   // Promise, set once init starts
let _diskStore = null;   // { [query]: { t, d } } mirrored to disk
let _diskFile = null;
let _diskFs = null;
let _diskTimer = null;

// Off unless the caller opts in (cli.mjs sets WCL_GQL_CACHE=1). This keeps the
// tests -- which also run under Node -- on the pure in-memory path, and lets the
// test suite point the cache at a temp file via WCL_GQL_CACHE_FILE.
const diskEnabled = () => IS_NODE && typeof process !== "undefined" && process.env.WCL_GQL_CACHE === "1";

async function initDisk() {
  if (!diskEnabled()) return;
  if (_diskReady) return _diskReady;
  _diskReady = (async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    _diskFs = fs;
    _diskFile = process.env.WCL_GQL_CACHE_FILE ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".gql-cache.json");
    _diskStore = {};
    try {
      const raw = JSON.parse(fs.readFileSync(_diskFile, "utf8"));
      const now = Date.now();
      for (const [q, e] of Object.entries(raw)) {
        if (e && (now - e.t) < DISK_TTL_MS) { _diskStore[q] = e; _gqlCache.set(q, e.d); }
      }
    } catch { /* no cache file yet */ }
  })();
  return _diskReady;
}

function diskPut(query, data) {
  if (!_diskStore) return;
  _diskStore[query] = { t: Date.now(), d: data };
  // Debounced write; the pending timer keeps the event loop alive, so the CLI
  // won't exit before the cache is flushed.
  clearTimeout(_diskTimer);
  _diskTimer = setTimeout(_flushDisk, 300);
}

function _flushDisk() {
  clearTimeout(_diskTimer);
  if (!_diskStore || !_diskFs) return;
  try { _diskFs.writeFileSync(_diskFile, JSON.stringify(_diskStore)); } catch {}
}

// Test-only hooks: flush the debounced write now, and forget all disk state so a
// fresh initDisk() re-reads the file (simulating a separate CLI run).
export function _flushGqlDisk() { _flushDisk(); }
export function _resetGqlDisk() { clearTimeout(_diskTimer); _diskReady = _diskStore = _diskFile = _diskFs = null; }

// Absolute time (ms) the WCL point budget resets, learned from a 429's
// Retry-After or primed up front (so connected sessions, where Retry-After is
// CORS-hidden on the direct WCL call, can still show a real ETA).
let _resetAt = 0;

// Connected sessions: read the reset clock once while we're still UNDER budget,
// so a later 429 (with no readable Retry-After) can still say when to retry.
// Best-effort and connected-only; anon sessions get Retry-After from the Worker.
export async function primeRateReset() {
  if (IS_NODE || !getAccessToken()) return;
  try {
    const d = await gql("query { rateLimitData { pointsResetIn } }");
    const s = d && d.rateLimitData && d.rateLimitData.pointsResetIn;
    if (s > 0) _resetAt = Math.max(_resetAt, Date.now() + s * 1000);
  } catch (e) { /* best-effort */ }
}

export async function gql(query, retries = 6) {
  await initDisk();                 // seeds _gqlCache from disk on first call (Node)
  if (_gqlCache.has(query)) return _gqlCache.get(query);
  if (_gqlInflight.has(query)) return _gqlInflight.get(query);
  if (PERSIST) {
    const stored = _cacheRead(query);
    if (stored !== undefined) { _gqlCache.set(query, stored); return stored; }
  }
  const p = _gqlRun(query, retries);
  _gqlInflight.set(query, p);
  try {
    const data = await p;
    _gqlCache.set(query, data);
    diskPut(query, data);              // Node CLI disk cache (no-op in the browser)
    if (PERSIST) _cacheWrite(query, data); // browser localStorage cache (1h TTL)
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
      // Reset seconds: from the forwarded Retry-After (anon/Worker path) or, when
      // that header is CORS-hidden (connected direct-to-WCL), from the reset clock
      // primed by primeRateReset(). Whichever we learn, remember it.
      if (retryAfter) _resetAt = Math.max(_resetAt, Date.now() + retryAfter * 1000);
      const eff = retryAfter || (_resetAt > Date.now() ? Math.ceil((_resetAt - Date.now()) / 1000) : null);
      const connected = !IS_NODE && !!getAccessToken();
      const mins = eff ? Math.max(1, Math.ceil(eff / 60)) : null;
      const when = mins ? `try again in ~${mins} min` : "try again shortly";
      const whose = connected
        ? "your WCL hourly point budget is used up"
        : "the app's shared WCL hourly budget is used up";
      const tip = connected ? "" : " (connect your Warcraft Logs account to use your own budget)";
      last = new Error(`WCL rate limit reached — ${whose}. ${when}${tip}.`);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wcl-ratelimit", { detail: { retryAfter: eff } }));
      await sleep(eff ? Math.min(20000, eff * 1000) : Math.min(12000, 2000 * 2 ** attempt));
      continue;
    }
    if (j.error) throw new Error(j.error); // other non-GraphQL error
    if (!j.data) throw new Error("no data: " + JSON.stringify(j).slice(0, 200));
    return j.data;
  }
  throw last;
}

// ---- Wowhead lookups (tooltips + item XML) ----------------------------------
// One path for all of them: direct to Wowhead when trusted (Node) or connected
// (own token), else through the Worker proxy (which caches a week). Coalesces
// concurrent identical fetches within a session and times out hung sockets.
const WOWHEAD_SPELL = "https://nether.wowhead.com/tooltip/spell/";
const WOWHEAD_ZONE = "https://nether.wowhead.com/tooltip/zone/";
const WOWHEAD_ITEM_XML = "https://www.wowhead.com/item=";
const _whInflight = new Map();
async function wowhead(directUrl, workerPath, parse = "json") {
  const url = (IS_NODE || !!getAccessToken()) ? directUrl : `${WORKER_URL}${workerPath}`;
  if (_whInflight.has(url)) return _whInflight.get(url);
  // Node has no default UA Wowhead likes; the browser sends its own (and can't
  // override it anyway), so only set it under Node.
  const opts = withTimeout(IS_NODE ? { headers: { "User-Agent": "Mozilla/5.0" } } : {});
  const p = fetch(url, opts).then((r) => (parse === "text" ? r.text() : r.json()));
  _whInflight.set(url, p);
  try { return await p; } finally { _whInflight.delete(url); }
}

// Item tooltip JSON (real per-instance stats need the bonus IDs).
export function itemTooltip(id, bonusIds) {
  const bonus = (bonusIds || []).map(String);
  const q = bonus.length ? `?bonus=${bonus.join(":")}` : "";
  return wowhead(`${WOWHEAD}${encodeURIComponent(id)}${q}`, `/item/${id}${q}`);
}

// Spell tooltip JSON (for talent names).
export function spellTooltip(id) {
  return wowhead(`${WOWHEAD_SPELL}${encodeURIComponent(id)}`, `/spell/${id}`);
}

// Item XML (text): the tooltip JSON omits the drop source's zone id, but the
// XML's <json> block has `sourcemore` (zone id per source) so we can name the
// instance an item drops in.
export function itemXml(id) {
  return wowhead(`${WOWHEAD_ITEM_XML}${encodeURIComponent(id)}&xml`, `/itemxml/${id}`, "text");
}

// Zone tooltip JSON ({name, ...}) -- resolves a zone id to its name.
export function zoneTooltip(id) {
  return wowhead(`${WOWHEAD_ZONE}${encodeURIComponent(id)}`, `/zone/${id}`);
}

// The connected user's most-recently-active characters. Just the cheap recency
// pass: list every claimed character with its most-recent-report time, newest
// first, capped to ACTIVE_MAX. No per-character zoneRankings -- scoring every
// claimed character for current-tier parses was point-expensive enough to
// rate-limit the account, slow, AND it wrongly hid active characters with no
// *ranked* current-tier kill. Recency is the honest "active" signal and one
// light query. Connected-only and best-effort; a schema miss degrades to the
// bare list (or []).
const ACTIVE_MAX = 15; // most-recently-active characters to surface in the picker

export async function myCharacters() {
  if (IS_NODE || !getAccessToken()) return [];
  const loc = "name server { slug region { slug } }";
  for (const sel of [`${loc} recentReports(limit: 1) { data { startTime } }`, loc]) {
    try {
      const d = await gql(`{ userData { currentUser { characters { ${sel} } } } }`);
      const raw = (d && d.userData && d.userData.currentUser && d.userData.currentUser.characters) || [];
      const chars = raw.map((c) => ({
        name: c.name,
        server: c.server && c.server.slug,
        region: ((c.server && c.server.region && c.server.region.slug) || "").toUpperCase(),
        last: ((c.recentReports && c.recentReports.data && c.recentReports.data[0]) || {}).startTime || 0,
      })).filter((c) => c.name && c.server && c.region);
      chars.sort((a, b) => b.last - a.last); // most recently active first
      return chars.slice(0, ACTIVE_MAX);
    } catch { /* bad field / no permission -> try the simpler shape */ }
  }
  return [];
}
