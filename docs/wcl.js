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
// reload re-spends the user's own quota (a full analysis is many big requests).
// So stash successful results across reloads with a 1h TTL (WCL rankings/reports
// are static enough within the hour). Backed by IndexedDB, NOT localStorage:
// ranking/event responses are far too big for localStorage's ~5MB budget, but
// IndexedDB holds large blobs and many of them. Browser only (PERSIST); the
// CLI/tests use the in-memory + on-disk caches. Every access is wrapped, so a
// storage failure just falls through to the network.
// Browser-only normally; tests force it on under Node (WCL_PERSIST_TEST=1) where
// the store falls back to an in-memory map, so the cross-reload behavior is testable.
const PERSIST = !IS_NODE ||
  (typeof process !== "undefined" && process.env && process.env.WCL_PERSIST_TEST === "1");
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Short, stable key from the query text (FNV-1a). Collisions are made safe by
// storing the query alongside the value and verifying it on read.
function _hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return "q" + (h >>> 0).toString(36);
}

// Backing store: IndexedDB in the browser, an in-memory Map otherwise (Node tests).
const _memStore = new Map();
let _idbPromise = null;
function _openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open("wcl-gql-cache", 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore("q"); } catch { /* exists */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return _idbPromise;
}
function _idbOp(mode, fn) {
  return _openIdb().then((db) => db && new Promise((resolve) => {
    try {
      const tx = db.transaction("q", mode);
      const rq = fn(tx.objectStore("q"));
      tx.oncomplete = () => resolve(rq && rq.result);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));
}
async function _storeGet(key) {
  if (typeof indexedDB !== "undefined") return _idbOp("readonly", (s) => s.get(key));
  return _memStore.get(key);
}
async function _storeSet(key, val) {
  if (typeof indexedDB !== "undefined") { await _idbOp("readwrite", (s) => s.put(val, key)); return; }
  _memStore.set(key, val);
}

// Exported for tests. Async. Returns undefined on miss / stale / collision / error.
export async function _cacheRead(query) {
  try {
    const e = await _storeGet(_hash(query));
    if (e && e.q === query && Date.now() - e.t < CACHE_TTL) return e.d;
  } catch { /* fall through to network */ }
  return undefined;
}
export async function _cacheWrite(query, data) {
  try { await _storeSet(_hash(query), { q: query, t: Date.now(), d: data }); } catch { /* skip caching */ }
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
    const os = await import("node:os");
    _diskFs = fs;
    // Shared across git worktrees (which split one WCL point budget): a single
    // cache in the user's home dir, not one file per worktree root. Override with
    // WCL_GQL_CACHE_FILE (the tests do).
    _diskFile = process.env.WCL_GQL_CACHE_FILE ||
      path.join(os.homedir(), ".cache", "warcraftlogs-analysis", "gql-cache.json");
    try { fs.mkdirSync(path.dirname(_diskFile), { recursive: true }); } catch { /* ignore */ }
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
  try {
    // Re-read and MERGE before writing: other worktrees share this file, so we
    // accumulate their entries instead of clobbering them (newest timestamp wins;
    // stale entries pruned). Write to a temp file + rename so a concurrent reader
    // never sees a half-written file.
    const now = Date.now();
    const merged = {};
    try {
      const onDisk = JSON.parse(_diskFs.readFileSync(_diskFile, "utf8"));
      for (const [q, e] of Object.entries(onDisk)) if (e && now - e.t < DISK_TTL_MS) merged[q] = e;
    } catch { /* no/invalid file -- just write ours */ }
    for (const [q, e] of Object.entries(_diskStore)) if (!merged[q] || merged[q].t < e.t) merged[q] = e;
    const tmp = `${_diskFile}.${process.pid}.tmp`;
    _diskFs.writeFileSync(tmp, JSON.stringify(merged));
    _diskFs.renameSync(tmp, _diskFile);
    _diskStore = merged;
  } catch {}
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
  // Build the work as ONE promise before awaiting -- the persistent read is now
  // async (IndexedDB), so doing it outside the inflight map would let concurrent
  // callers all miss the cache and double-fetch. Set inflight synchronously.
  const p = (async () => {
    if (PERSIST) {
      const stored = await _cacheRead(query);
      if (stored !== undefined) return stored; // cross-reload hit -- no network
    }
    const fresh = await _gqlRun(query, retries);
    diskPut(query, fresh);              // Node CLI disk cache (no-op in the browser)
    if (PERSIST) _cacheWrite(query, fresh); // browser IndexedDB cache (1h TTL), fire-and-forget
    return fresh;
  })();
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
const WOWHEAD_NPC = "https://nether.wowhead.com/tooltip/npc/";
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

// NPC tooltip JSON ({name, map:{zone}, ...}) -- gives a boss's instance zone id
// when the item itself doesn't carry one.
export function npcTooltip(id) {
  return wowhead(`${WOWHEAD_NPC}${encodeURIComponent(id)}`, `/npc/${id}`);
}

// The connected user's characters that actually RAIDED the current tier, most
// kills first. Two bounded phases so we never rank every claimed character (that
// rate-limited the account):
//   1) cheap: list all characters + recency, keep the ACTIVE_SCAN most recent.
//   2) for just those, count current-zone kills across all difficulties; keep
//      the ones with >0 (so dungeon-only / never-raided characters drop out).
// Kills are counted regardless of rankPercent -- an unranked kill still means
// they raided, which is what wrongly hid an active character before. zoneRankings
// (current zone) + totalKills is exactly what detectContext reads, so this is the
// proven-correct shape. Best-effort: if scoring fails, fall back to the recency
// list rather than an empty picker.
const ACTIVE_SCAN = 20; // most-recently-active characters to check for raid kills

export async function myCharacters() {
  if (IS_NODE || !getAccessToken()) return [];
  const loc = "name server { slug region { slug } }";

  // Phase 1 (cheap): claimed characters + most-recent-report time.
  let base = null;
  for (const sel of [`${loc} recentReports(limit: 1) { data { startTime } }`, loc]) {
    try {
      const d = await gql(`{ userData { currentUser { characters { ${sel} } } } }`);
      const raw = (d && d.userData && d.userData.currentUser && d.userData.currentUser.characters) || [];
      base = raw.map((c) => ({
        name: c.name,
        server: c.server && c.server.slug,
        region: ((c.server && c.server.region && c.server.region.slug) || "").toUpperCase(),
        last: ((c.recentReports && c.recentReports.data && c.recentReports.data[0]) || {}).startTime || 0,
        kills: 0,
      })).filter((c) => c.name && c.server && c.region);
      break;
    } catch { base = null; } // try the simpler shape
  }
  if (!base || !base.length) return base || [];
  base.sort((a, b) => b.last - a.last);
  const subset = base.slice(0, ACTIVE_SCAN);

  // Phase 2 (bounded): current-tier kills for the active subset, all difficulties.
  const killsIn = (zr) => ((zr && zr.rankings) || []).reduce((n, r) => n + ((r && r.totalKills) || 0), 0);
  const q = (s) => JSON.stringify(s);
  const fields = subset.map((c, i) =>
    `c${i}: character(name: ${q(c.name)}, serverSlug: ${q(c.server)}, serverRegion: ${q(c.region)}) {` +
    " m: zoneRankings(difficulty: 5) h: zoneRankings(difficulty: 4)" +
    " n: zoneRankings(difficulty: 3) lfr: zoneRankings(difficulty: 1) }").join("\n");
  try {
    const d = await gql(`{ characterData { ${fields} } }`);
    const cd = (d && d.characterData) || {};
    subset.forEach((c, i) => {
      const x = cd["c" + i];
      if (x) c.kills = killsIn(x.m) + killsIn(x.h) + killsIn(x.n) + killsIn(x.lfr);
    });
  } catch { /* keep the recency-ordered subset; kills stay 0 */ }

  // Only characters that raided the current tier, most kills first. If scoring
  // produced nothing (a miss), fall back to recency so the picker isn't empty.
  const raided = subset.filter((c) => c.kills > 0).sort((a, b) => b.kills - a.kills);
  return raided.length ? raided : subset;
}
