// @ts-check
// WCL GraphQL + Wowhead tooltips. Two paths, no secret in the page:
//   Node/CLI  -> client-credentials (env/.env) -> /api/v2/client, direct.
//   browser   -> the user's own PKCE token (auth.js) -> /api/v2/user, direct.
// Connect-only in the browser: there is NO shared/anonymous proxy path, so every
// run spends the connected user's OWN hourly point budget (a full analysis is
// many heavy requests; a shared budget can't carry it). No token -> NeedsAuth.
// (The Cloudflare Worker still proxies Wowhead tooltips below -- no WCL secret.)
import {
  IS_NODE, TOKEN_URL, CLIENT_API_URL, USER_API_URL, WOWHEAD_URL, WORKER_URL,
} from "./config.js";
import { getAccessToken, logout } from "./auth.js";

export class PrivateReport extends Error {}

// Raised when the browser has no valid token (or it expired). Callers catch this
// to send the user through the connect flow instead of showing a network error.
export class NeedsAuth extends Error {}

// Raised when WCL's shared hourly point budget is used up (HTTP 429). Carries
// `resetIn` (seconds until the budget refreshes) when we could learn it -- from
// the 429's Retry-After or the reset clock primed by primeRateReset() -- so a
// caller (pacing logic, the loop) can wait EXACTLY until the quota is back instead
// of guessing. null `resetIn` means we couldn't read a clock this time.
export class RateLimited extends Error {
  /** @param {string} message @param {number|null} [resetIn] */
  constructor(message, resetIn = null) { super(message); this.resetIn = resetIn; }
}

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
  // Read Retry-After like the browser path so the CLI's 429 message can say WHEN
  // the budget resets (it talks direct to WCL, which sends the header) instead of
  // the vague "try again shortly".
  return { status: r.status, j: await r.json().catch(() => ({})), retryAfter: readRetryAfter(r) };
}

// Reset hint (seconds) WCL / the Worker may send on a 429, for the UI countdown.
const readRetryAfter = (r) => {
  const n = parseInt(r.headers.get("Retry-After") || "", 10);
  return Number.isFinite(n) ? n : null;
};

// ---- Browser path: the user's own PKCE token (connect-only) -------------------
async function browserWcl(query) {
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
// Same TTL as the Node on-disk cache (DISK_TTL_MS, ~1 week) so the browser and CLI
// behave identically: a kill's report data never expires (see _isImmutable), and
// ranking/world/character queries refresh ~weekly -- NOT hourly, which made the
// browser re-spend points on data the CLI still had cached. (Browsers may still
// evict IndexedDB under storage pressure; that's out of our control.)
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
// A specific logged kill's report data (events/tables for a report+fight) never
// changes once logged -- so it must never expire from any cache. Ranking/world/
// character queries (the "field") DO drift, so they keep a finite TTL.
// `meta:` keys are our OWN fingerprints (e.g. a character's kill-signature), not WCL
// queries -- they never expire and must survive pruneStaleCache, same as a logged kill.
const _isImmutable = (q) => /report\s*\(\s*code\s*:/.test(q) || q.startsWith("meta:");

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
  // Ask the browser to KEEP this cache through storage pressure. Without this,
  // IndexedDB is "best-effort" storage the browser may evict at any time -- which is
  // the cache "purging" you'd see: immutable report data has no TTL (it's cached
  // forever), so if it vanishes it was evicted, not expired. Fire-and-forget;
  // harmless where unsupported or denied.
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* ignore */ }
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
    const ttl = _isImmutable(query) ? Infinity : (_preferCache ? FIELD_STALE_CAP_MS : CACHE_TTL);
    if (e && e.q === query && Date.now() - e.t < ttl) return e.d;
  } catch { /* fall through to network */ }
  return undefined;
}
export async function _cacheWrite(query, data) {
  try { await _storeSet(_hash(query), { q: query, t: Date.now(), d: data }); } catch { /* skip caching */ }
}

export function clearGqlCache() { _gqlCache.clear(); _loadedShards.clear(); }  // cleared cache reloads shards lazily

// Force-refresh the DRIFT-ABLE data without re-spending points on logged kills.
// Rankings/world/character queries (the "field" you're compared to) carry a ~weekly
// TTL, so a stale browser cache can keep serving an out-of-date field for days --
// the exact failure where an improved player still sees an old "you're X% behind".
// This drops ONLY the non-immutable entries (same _isImmutable rule as the TTL), in
// the in-memory cache AND the persistent store, so the next analysis re-fetches the
// field fresh while every cached kill report (immutable, the expensive part) stays.
// Returns { kept, dropped } counts. Best-effort: storage errors resolve to whatever
// was pruned so far rather than throwing into the UI.
export async function pruneStaleCache() {
  let kept = 0, dropped = 0;
  // In-memory (this session): so a re-run doesn't read the stale value back before
  // the persistent prune lands.
  for (const q of [..._gqlCache.keys()]) if (!_isImmutable(q)) { _gqlCache.delete(q); dropped++; } else kept++;
  // Persistent store: IndexedDB (browser) cursor-delete, or the in-memory Map (Node).
  try {
    if (typeof indexedDB !== "undefined") {
      const db = await _openIdb();
      if (db) await /** @type {Promise<void>} */ (new Promise((resolve) => {
        try {
          const cur = db.transaction("q", "readwrite").objectStore("q").openCursor();
          cur.onsuccess = (e) => {
            const c = e.target.result;
            if (!c) return resolve();
            if (c.value && !_isImmutable(c.value.q)) { c.delete(); dropped++; } else kept++;
            c.continue();
          };
          cur.onerror = () => resolve();
        } catch { resolve(); }
      }));
    } else {
      for (const [k, v] of [..._memStore.entries()]) if (v && !_isImmutable(v.q)) { _memStore.delete(k); dropped++; } else kept++;
    }
  } catch { /* fall through with whatever we pruned */ }
  return { kept, dropped };
}

// ---- Node-only on-disk cache -------------------------------------------------
// The browser path is already cached by the Worker (shared, keyed by query
// hash). Node talks straight to WCL, so without this every CLI run re-fetches
// everything and back-to-back runs trip WCL's per-IP 429 throttle. Persisting
// successful GraphQL results between runs makes iterating ~free. No effect in
// the browser (guarded by IS_NODE; node:* imports are dynamic).
// Immutable report data is cached FOREVER (see _isImmutable); ranking/world/
// character queries keep a finite TTL -- weekly, not hours, so a roster review
// spanning several days stays warm instead of aging out and re-spending points.
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // rankings: refresh ~weekly
const _ttlFor = (q) => (_isImmutable(q) ? Infinity : DISK_TTL_MS);
// The ceiling on serving a STALE field (drift-able data) without re-fetching: a month.
// Two callers reuse the cached field past its weekly TTL instead of re-spending points
// -- a cache-only run (no fetching, so stale beats a CacheMiss) and an unchanged-player
// re-review (your kill-signature matches, so you didn't raid -- see revalidateCharacter).
// Past this cap we refetch even when unchanged, so the field can't drift indefinitely.
const FIELD_STALE_CAP_MS = 28 * 24 * 60 * 60 * 1000;
let _preferCache = false;
// Turn on reuse-the-stale-field mode for the rest of this run. One char per process
// (the CLI and the browser each analyze a single character), so a process-global flag
// is safe -- it's set once up front, never toggled mid-analysis.
export function setPreferCache(v) { _preferCache = !!v; }
export function preferCache() { return _preferCache; }
// TTL applied when DECIDING whether a cached entry is fresh enough to SERVE. Immutable
// data never expires; with fetching off (cache-only) any cache beats a miss; when the
// player is unchanged we reuse the field up to the cap; otherwise the normal weekly TTL.
const _ttlForRead = (q) => {
  if (_isImmutable(q)) return Infinity;
  if (cacheOnly()) return Infinity;
  if (_preferCache) return FIELD_STALE_CAP_MS;
  return _ttlFor(q);
};
// What we KEEP on disk at flush. Eviction is now LRU-by-SIZE (see _evictLru), NOT by age, so
// flush keeps every entry regardless of age -- a character you keep reviewing never time-expires.
// (Read-eligibility / fetch-mode freshness of drift-able data is still gated by _ttlForRead, so a
// stale field is refetched on use even though it stays on disk.) FIELD_STALE_CAP_MS is now used
// only by _ttlForRead (the preferCache serve cap), not for retention.
const _ttlForKeep = (_q) => Infinity;
// LRU budget: the cache is bounded by SIZE, evicting the least-recently-ACCESSED shards (by file
// mtime, which _loadShardInto touches on read), NOT by age. So review never lapses on a timer;
// the cache only shrinks when it exceeds the budget. Generous default, env-overridable. Evicted
// shards refetch identically (immutable data) -- a budget cost, not data loss. Read at evict time
// so tests/users can tune it.
const _maxCacheBytes = () => (Number(process.env.WCL_CACHE_MAX_MB) || 2048) * 1024 * 1024;
let _evictDone = false;   // size check runs once per process
// Persisted fingerprint store (Node disk cache). Used by revalidateCharacter to remember
// a character's kill-signature across runs. `meta:` keys are immutable (never pruned).
export function metaGet(key) { const q = "meta:" + key; _ensureLoaded(q); return _gqlCache.has(q) ? _gqlCache.get(q) : undefined; }
export function metaPut(key, data) { const q = "meta:" + key; _gqlCache.set(q, data); diskPut(q, data); }
let _diskReady = null;   // Promise, set once init starts
let _diskStore = null;   // { [query]: { t, d } } -- the whole cache, in memory
let _diskFile = null;    // legacy monolith path (still READ for back-compat + migrated away)
let _diskDir = null;     // directory of shard files -- the real on-disk store
let _diskFs = null;
let _diskPath = null;
let _diskZlib = null;
let _diskTimer = null;
let _loadedShards = new Set();   // which shard ids have been lazily read in this process

// Lazily make a query's cached value available, decompressing only the shard(s) it
// needs -- replaces gunzipping ALL shards at startup (~26s on a warm cache, the old
// dominant CLI latency). Reads the 3-hex shard first; on a miss, falls back to the
// legacy 2-hex shard and MIGRATES its entries into 3-hex shards (marks them dirty) so
// the next run finds them in the small fast shard. No-op in the browser (_diskStore
// null). MUST run before gql()'s _gqlCache.has() check or a warm entry refetches.
function _ensureLoaded(query) {
  if (!_diskStore || !_diskFs || _gqlCache.has(query)) return;
  _loadShardInto(_shardId(query), false);          // primary: the new fine (3-hex) shard
  if (_gqlCache.has(query)) return;
  _loadShardInto(_oldShardId(query), true);         // fallback: legacy 2-hex shard, migrate-on-read
}

// Read one shard file (gzipped, plus a legacy plain one if present) into _gqlCache +
// _diskStore, applying TTL. Idempotent per process via _loadedShards; synchronous
// (initDisk already imported fs/zlib). `migrate`: this is a legacy 2-hex shard, so mark
// every loaded entry dirty to rewrite it into its 3-hex shard (one-way, additive -- the
// 2-hex shard is never deleted, so old code keeps reading it).
function _loadShardInto(id, migrate) {
  if (_loadedShards.has(id)) return;
  _loadedShards.add(id);           // mark first: a missing/corrupt shard isn't retried every call
  const now = Date.now();
  let migrated = false;
  for (const file of [_shardFile(id), _legacyShardFile(id)]) {
    let buf; try { buf = _diskFs.readFileSync(file); } catch { continue; }   // shard not written yet
    try { _diskFs.utimesSync(file, now / 1000, now / 1000); } catch { /* mtime touch is best-effort -- it's the LRU recency signal */ }
    try {
      for (const [q, e] of Object.entries(_decodeShard(buf)))
        if (e && (now - e.t) < _ttlForRead(q) && (!_diskStore[q] || _diskStore[q].t < e.t)) {
          _diskStore[q] = e; _gqlCache.set(q, e.d);
          if (migrate) { _dirty.add(_shardId(q)); migrated = true; }
        }
    } catch { /* a corrupt shard is skipped -- the next flush preserves it (never-clobber) */ }
  }
  if (migrated) { clearTimeout(_diskTimer); _diskTimer = setTimeout(_flushDisk, 1000); }  // persist the 3-hex copies
}

// Decode a shard file's raw bytes to its JSON object. Shards are gzipped (WCL
// event/table JSON compresses ~7x), but we SNIFF the gzip magic (1f 8b) so we
// transparently read BOTH gzipped (new) and plain-JSON (old monolith / in-flight
// shards from pre-compression code) -- no flag-day migration. Throws on corrupt input.
function _decodeShard(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const raw = (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) ? _diskZlib.gunzipSync(b) : b;
  return JSON.parse(raw.toString("utf8"));
}
let _migrate = false;            // a legacy monolith was found -> distribute it into shards
let _flushRetries = 0;           // bounded retries for a preserved (unreadable) shard
const _dirty = new Set();        // shard ids with unpersisted puts (or pending migration)

// The cache is SHARDED across many small files (one per query-hash bucket) instead
// of one giant JSON. Why: a single ~400MB file had to be fully re-read, re-parsed
// and re-written on every flush -- slow, memory-heavy, and (the disaster) if that
// parse ever failed under concurrent load the catch wrote only THIS process's small
// store, atomically clobbering the shared cache (396MB -> 38MB). Small shards parse
// instantly, can't hit V8's ~512MB string ceiling (so total capacity is effectively
// unbounded), only the touched shards rewrite, and a failed read can never lose more
// than one tiny shard -- which the never-clobber guard below also refuses to do.
// 4096 shards (3 hex), up from 256 (2 hex): a run touches only a handful of queries
// per shard, so loading one shard parses ~3 entries instead of ~47. Whole-cache parse
// is fine; parsing a 9MB shard to use 1-2 entries was the full-run latency. The 2-hex
// scheme stays readable as a FALLBACK (_oldShardId) so the existing on-disk cache isn't
// orphaned and OTHER worktrees still on 2-hex code keep working -- we never delete a
// 2-hex shard; entries migrate into 3-hex shards lazily the first time they're read.
const _fnv = (query) => { let h = 0x811c9dc5; for (let i = 0; i < query.length; i++) { h ^= query.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
export function _shardId(query) { return (_fnv(query) & 0xfff).toString(16).padStart(3, "0"); }     // 3 hex (new, canonical)
export function _oldShardId(query) { return (_fnv(query) & 0xff).toString(16).padStart(2, "0"); }    // 2 hex (legacy read fallback)
// New shards are gzipped with a distinct extension (.json.gz). The distinct name
// is the migration aid: pre-compression code (readdir filter `.endsWith(".json")`)
// simply IGNORES .json.gz instead of choking on gzip bytes, and new code reads both
// and rewrites legacy .json shards as .json.gz (then deletes the .json).
const _shardFile = (id) => _diskPath.join(_diskDir, `${id}.json.gz`);
const _legacyShardFile = (id) => _diskPath.join(_diskDir, `${id}.json`);

// Off unless the caller opts in (cli.mjs sets WCL_GQL_CACHE=1). This keeps the
// tests -- which also run under Node -- on the pure in-memory path, and lets the
// test suite point the cache at a temp file via WCL_GQL_CACHE_FILE.
const diskEnabled = () => IS_NODE && typeof process !== "undefined" && process.env.WCL_GQL_CACHE === "1";

// SINGLE-WRITER / opt-in fetching (Node). The shared hourly WCL point budget is the
// scarce resource, and the disaster cascaded because ANY process could spend it
// (parallel runs, stuck old processes, the loop -- all at once). So under Node,
// hitting the network is OPT-IN: a caller must set WCL_ALLOW_FETCH=1 to permit it.
// By DEFAULT a cache MISS throws CacheMiss instead of fetching -- background, agent,
// and parallel runs can never accidentally drain the budget; only the roster loop or
// an explicit `--allow-fetch` fetches. WCL_CACHE_ONLY=1 forces read-only even when
// fetching is allowed (a hard override). The BROWSER is unaffected (not IS_NODE): the
// user spends their OWN token there and the app must fetch.
const cacheOnly = () => IS_NODE && typeof process !== "undefined" &&
  (process.env.WCL_CACHE_ONLY === "1" || process.env.WCL_ALLOW_FETCH !== "1");
export class CacheMiss extends Error {
  constructor(q) {
    super("not cached, and fetching is off (set WCL_ALLOW_FETCH=1 / pass --allow-fetch to spend WCL points)");
    this.name = "CacheMiss"; this.q = q;
  }
}

async function initDisk() {
  if (!diskEnabled()) return;
  if (_diskReady) return _diskReady;
  _diskReady = (async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const zlib = await import("node:zlib");
    _diskFs = fs; _diskPath = path; _diskZlib = zlib;
    _diskFile = await _defaultCacheFile();
    _diskDir = `${_diskFile}.shards`;
    try { fs.mkdirSync(_diskDir, { recursive: true }); } catch { /* ignore */ }
    _diskStore = {};
    _loadedShards.clear();
    // Cheaply detect whether a one-time MIGRATION is owed -- a legacy monolith file, or
    // any plain .json shard -- WITHOUT decompressing anything (just stat + a filename
    // scan). Steady state (all shards already .json.gz, no monolith) skips the bulk load
    // ENTIRELY: each shard then loads LAZILY via _ensureLoaded on the first query
    // that needs it. initDisk used to gunzip ALL ~256 shards here, which was ~the entire
    // CLI startup latency (~26s on a warm cache) -- paid before any analysis ran.
    let legacyShards = false, haveMonolith = false;
    try { for (const f of fs.readdirSync(_diskDir)) if (f.endsWith(".json") && !f.endsWith(".json.gz")) { legacyShards = true; break; } } catch { /* no dir yet */ }
    try { haveMonolith = fs.existsSync(_diskFile); } catch { /* none */ }
    if (haveMonolith || legacyShards) {
      // Back-compat one-time migration: read the old monolithic gql-cache.json and/or any
      // legacy plain .json shards, then rewrite as gzipped .json.gz and remove the
      // originals. Flush EAGERLY so even a read-only / cache-only run migrates (no WCL
      // points -- it's a disk reformat). This is the only path that still bulk-loads.
      const now = Date.now();
      const load = (buf) => {
        try {
          for (const [q, e] of Object.entries(_decodeShard(buf)))
            if (e && (now - e.t) < _ttlFor(q) && (!_diskStore[q] || _diskStore[q].t < e.t)) { _diskStore[q] = e; _gqlCache.set(q, e.d); }
        } catch { /* a corrupt shard is skipped -- every other shard still loads */ }
      };
      try {
        for (const f of fs.readdirSync(_diskDir)) {
          if (!f.endsWith(".json") && !f.endsWith(".json.gz")) continue;
          load(fs.readFileSync(path.join(_diskDir, f)));
          _loadedShards.add(f.replace(/\.json(\.gz)?$/, ""));   // pre-mark: don't lazily re-read it
        }
      } catch { /* none yet */ }
      try { load(fs.readFileSync(_diskFile)); } catch { /* no monolith */ }
      _migrate = haveMonolith;                              // only the monolith file needs deleting
      for (const q of Object.keys(_diskStore)) _dirty.add(_shardId(q));
      if (_dirty.size) { clearTimeout(_diskTimer); _diskTimer = setTimeout(_flushDisk, 0); }
    }
  })();
  return _diskReady;
}

function diskPut(query, data) {
  if (!_diskStore) return;
  _diskStore[query] = { t: Date.now(), d: data };
  _dirty.add(_shardId(query));
  // Debounced write; the pending timer keeps the event loop alive, so the CLI
  // won't exit before the cache is flushed.
  clearTimeout(_diskTimer);
  _diskTimer = setTimeout(_flushDisk, 1000);
}

function _flushDisk() {
  clearTimeout(_diskTimer);
  if (!_diskStore || !_diskFs || !_dirty.size) return;
  const now = Date.now();
  // Bucket our (non-expired) entries by shard once.
  const ours = {};
  for (const [q, e] of Object.entries(_diskStore)) {
    if (now - e.t >= _ttlForKeep(q)) continue;
    const s = _shardId(q);
    (ours[s] || (ours[s] = {}))[q] = e;
  }
  const stillDirty = new Set();
  for (const s of _dirty) {
    const file = _shardFile(s);
    const merged = {};
    // Merge with this shard's on-disk content (other worktrees write it too).
    // NEVER-CLOBBER: if the file EXISTS but can't be read/parsed (a concurrent
    // rename, transient I/O), do NOT write -- writing only our slice would wipe the
    // other process's entries. Preserve it and retry. This is the guard whose
    // absence (on the old monolith) caused the 396MB->38MB truncation.
    try {
      for (const [q, e] of Object.entries(_decodeShard(_diskFs.readFileSync(file))))
        if (e && now - e.t < _ttlForKeep(q)) merged[q] = e;
    } catch (err) {
      if (!(err && err.code === "ENOENT")) { stillDirty.add(s); continue; }  // exists but unreadable -> keep it
    }
    for (const [q, e] of Object.entries(ours[s] || {})) if (!merged[q] || merged[q].t < e.t) merged[q] = e;
    if (!Object.keys(merged).length) continue;   // nothing to persist for this shard
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      _diskFs.writeFileSync(tmp, _diskZlib.gzipSync(Buffer.from(JSON.stringify(merged))));  // ~7x smaller on disk
      _diskFs.renameSync(tmp, file);
      // This shard is now persisted compressed -- drop any legacy plain .json for it.
      try { _diskFs.unlinkSync(_legacyShardFile(s)); } catch { /* none */ }
    } catch { stillDirty.add(s); try { _diskFs.unlinkSync(`${file}.${process.pid}.tmp`); } catch {} }
  }
  _dirty.clear();
  for (const s of stillDirty) _dirty.add(s);
  // Migration done (every shard with data was written) -> drop the legacy monolith
  // so it can't be re-read or clobbered. Only when nothing is still pending.
  if (_migrate && !stillDirty.size) {
    try { _diskFs.unlinkSync(_diskFile); } catch {}
    _migrate = false;
  }
  // Retry shards we preserved (transient read/write failure) -- but bounded, so a
  // permanently-unreadable shard can't keep the process alive forever. A new put
  // resets the budget (diskPut clears nothing, but a clean flush below does).
  if (stillDirty.size && _flushRetries++ < 3) _diskTimer = setTimeout(_flushDisk, 2000);
  else _flushRetries = 0;
  // Bound the cache by SIZE once per process (after a write, off the hot path). Cheap
  // stat-only scan; only the rare over-budget case deletes anything.
  if (!_evictDone) { _evictDone = true; setTimeout(_evictLru, 0); }
}

// LRU eviction: when the on-disk cache exceeds the size budget, delete the
// least-recently-ACCESSED shard files (by mtime -- _loadShardInto touches it on every read, and
// flush rewrites touch it on write) down to 90% of the budget. RECENCY-based, never age-based:
// a shard you keep reading keeps a fresh mtime and survives; only cold shards are dropped, and
// they refetch identically. Stat-only scan (no decompress). Best-effort: any FS hiccup just
// skips eviction, leaving the cache intact (never a partial/corrupt delete of a shard's content
// -- we remove whole files atomically, so the never-clobber invariant holds).
function _evictLru() {
  if (!_diskFs || !_diskDir || !_diskPath) return;
  let names; try { names = _diskFs.readdirSync(_diskDir); } catch { return; }
  const shards = names.filter((f) => f.endsWith(".json.gz") || f.endsWith(".json"));
  const stats = []; let total = 0;
  for (const f of shards) {
    try { const st = _diskFs.statSync(_diskPath.join(_diskDir, f)); stats.push([f, st.size, st.mtimeMs]); total += st.size; }
    catch { /* vanished mid-scan -- skip */ }
  }
  const budget = _maxCacheBytes();
  if (total <= budget) return;
  const target = budget * 0.9;                 // evict to 90% so it doesn't run every session
  stats.sort((a, b) => a[2] - b[2]);           // least-recently-accessed (oldest mtime) first
  for (const [f, size] of stats) {
    if (total <= target) break;
    try { _diskFs.unlinkSync(_diskPath.join(_diskDir, f)); total -= size; } catch { /* skip */ }
  }
}
export function _evictGqlLru() { _evictLru(); }   // test hook

// Test-only hooks: flush the debounced write now, and forget all disk state so a
// fresh initDisk() re-reads the shards (simulating a separate CLI run).
export function _flushGqlDisk() { _flushDisk(); }
export function _resetGqlDisk() {
  clearTimeout(_diskTimer); _dirty.clear(); _migrate = false; _flushRetries = 0; _loadedShards.clear();
  _evictDone = false;
  _diskReady = _diskStore = _diskFile = _diskDir = _diskFs = _diskPath = _diskZlib = null;
}

// Absolute time (ms) the WCL point budget resets, learned from a 429's
// Retry-After or primed up front (so connected sessions, where Retry-After is
// CORS-hidden on the direct WCL call, can still show a real ETA).
let _resetAt = 0;

// Read the reset clock once while we're still UNDER budget, so a later 429 (with
// no readable Retry-After) can still say when to retry. Runs for the Node CLI and
// connected browser sessions (both query WCL directly); anon browser sessions
// skip it -- they get Retry-After forwarded from the Worker instead.
export async function primeRateReset() {
  if (!IS_NODE && !getAccessToken()) return;
  try {
    const d = await gql("query { rateLimitData { pointsResetIn } }");
    const s = d && d.rateLimitData && d.rateLimitData.pointsResetIn;
    if (s > 0) _resetAt = Math.max(_resetAt, Date.now() + s * 1000);
  } catch (e) { /* best-effort */ }
}

// Live WCL quota snapshot for pacing/visibility: hourly point limit, points spent
// this hour, remaining, and seconds to reset. Goes via _gqlRun (NOT gql) so it's
// never cached -- a cached quota reading would be stale and useless. null on error.
export async function rateLimit() {
  try {
    const d = (await _gqlRun("query { rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn } }", 1)).rateLimitData;
    if (!d) return null;
    const limit = d.limitPerHour || 0, spent = d.pointsSpentThisHour || 0;
    return { limit, spent, remaining: Math.max(0, limit - spent), resetIn: d.pointsResetIn || 0, limited: false };
  } catch (e) {
    // Already throttled: don't lose the timing. Report remaining 0 + the exact
    // reset clock so a caller waits precisely until the budget is back, not a
    // round guess. `limited: true` distinguishes this from a real null (unknown).
    if (e instanceof RateLimited) return { limit: 0, spent: 0, remaining: 0, resetIn: e.resetIn || 0, limited: true };
    return null;
  }
}

// --- single-fetcher lock + budget gate (Node/CLI) --------------------------------
// Enforce the single-writer rule in CODE, not just convention: at most ONE process
// may fetch (spend the shared budget) at a time, and only while a reserve of points
// remains. Anything denied degrades to cache-only. The lock is a file next to the
// cache; a dead or stale owner is stolen so a crashed run can't wedge it forever.
const _pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; } };

// The single cache-file path, shared across git worktrees (which split one WCL
// point budget): a location in the user's home dir, not one per worktree root.
// Override with WCL_GQL_CACHE_FILE (the tests do); shards + lock live next to it.
async function _defaultCacheFile() {
  const path = await import("node:path");
  const os = await import("node:os");
  return process.env.WCL_GQL_CACHE_FILE ||
    path.join(os.homedir(), ".cache", "warcraftlogs-analysis", "gql-cache.json");
}

async function _lockPath() {
  const path = await import("node:path");
  return path.join(path.dirname(await _defaultCacheFile()), "fetch.lock");
}

// Become the single fetcher. Returns a release() on success, or null if a live,
// recent process already holds the lock. Steals a dead/stale lock (crashed owner).
export async function acquireFetchLock({ staleMs = 15 * 60 * 1000 } = {}) {
  if (!IS_NODE) return () => {};
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = await _lockPath();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");                  // atomic exclusive create
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now() }));
      fs.closeSync(fd);
      const release = () => { try { if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.unlinkSync(file); } catch { /* gone/stolen */ } };
      process.once("exit", release);
      return release;
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
      let owner = null; try { owner = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* unreadable */ }
      const dead = !owner || (owner.pid && !_pidAlive(owner.pid)) || (owner.t && Date.now() - owner.t > staleMs);
      if (dead) { try { fs.unlinkSync(file); } catch { /* raced */ } continue; }  // steal + retry
      return null;                                          // held by a live, recent fetcher
    }
  }
  return null;
}

// Combined gate the CLI calls before enabling --allow-fetch: a budget reserve PLUS
// the single-fetcher lock. Returns { ok, reason, release, remaining }. When !ok the
// caller stays cache-only (no spend) and shows `reason`.
export async function acquireFetchGate({ reserve = 400 } = {}) {
  const rl = await rateLimit();
  if (rl && rl.limited) return { ok: false, reason: `WCL budget exhausted -- resets in ~${fmtRateWait(rl.resetIn) || "?"}` };
  if (rl && rl.remaining != null && rl.remaining < reserve)
    return { ok: false, reason: `only ${Math.round(rl.remaining)} WCL pts left (below the ${reserve} reserve) -- resets in ~${fmtRateWait(rl.resetIn) || "?"}` };
  const release = await acquireFetchLock();
  if (!release) return { ok: false, reason: "another run already holds the fetch lock (single-writer)" };
  return { ok: true, release, remaining: rl ? rl.remaining : null };
}

// --- automatic request batching (DataLoader-style) ---------------------------
// What this DOES buy: latency + request-count headroom (WCL also throttles requests/
// second), and the small ~1.2 pts/request fixed overhead. What it does NOT buy: the
// hourly POINTS budget -- billing is complexity-scaled (measured: ~4.25 pts/report of
// DATA regardless of packaging; probe-billing.mjs, 2026-06-14), so a combined N-report
// query costs ~N x a single one. To cut POINTS, fetch fewer UNITS (peers/kills/bosses),
// NOT tighter batches. So don't crank _BATCH_MAX or fan out loops expecting a quota win.
// Mechanism: concurrent cache-misses landing in the same microtask are combined into ONE
// GraphQL request via top-level aliasing, then the response is split back to each caller
// and cached under its OWN key. The peer mapLimit loops are already concurrent, so they
// batch with zero call-site wiring. Fail-soft + never wrong: if the combined request
// errors (a private report, a complexity cap, partial errors), _runCombinable BISECTS
// and retries each half down to individual requests, so each caller still gets its own
// result or error. GraphQL aliasing of multiple top-level fields is standard; our
// queries are all single-operation `query { <field> { … } }`.
const _BATCH_MAX = 6;            // reports per combined request (stay well under WCL's complexity cap)
const _noBatch = () => typeof process !== "undefined" && process.env && process.env.WCL_NO_BATCH === "1";
let _batchQueue = [];
let _batchScheduled = false;

// Split `query { <field> { … } }` into { field, inner } where inner is the aliasable
// selection (`<field> { … }`). null if it isn't the single-operation shape we combine.
function _splitQuery(query) {
  const open = query.indexOf("{"), close = query.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  const inner = query.slice(open + 1, close).trim();
  const m = inner.match(/^([A-Za-z_]\w*)/);
  return m ? { field: m[1], inner } : null;
}

function _enqueueBatched(query, retries) {
  return new Promise((resolve, reject) => {
    _batchQueue.push({ query, retries, resolve, reject });
    if (!_batchScheduled) { _batchScheduled = true; queueMicrotask(_flushBatch); }
  });
}

function _flushBatch() {
  _batchScheduled = false;
  const queue = _batchQueue; _batchQueue = [];
  for (let i = 0; i < queue.length; i += _BATCH_MAX) _runBatchChunk(queue.slice(i, i + _BATCH_MAX));
}

async function _runBatchChunk(chunk) {
  const parts = chunk.map((it) => ({ it, p: _splitQuery(it.query) }));
  const solo = parts.filter((x) => !x.p), combinable = parts.filter((x) => x.p);
  for (const { it } of solo) _gqlRun(it.query, it.retries).then(it.resolve, it.reject);  // unparseable -> individual
  await _runCombinable(combinable);
}

// Combine `items` into one aliased request; on failure BISECT and retry each half,
// bottoming out at an individual request. This degrades a too-big chunk toward WCL's
// REAL complexity cap (halve until it fits) and isolates a single bad report (private/
// partial-error) to its own request -- instead of dropping the whole chunk to
// one-request-per-caller. So _BATCH_MAX can be set optimistically: overshoot self-corrects.
async function _runCombinable(items) {
  if (items.length === 0) return;
  if (items.length === 1) { const { it } = items[0]; return _gqlRun(it.query, it.retries).then(it.resolve, it.reject); }
  const combined = `query { ${items.map((x, j) => `_${j}: ${x.p.inner}`).join(" ")} }`;
  const retries = Math.max(...items.map((x) => x.it.retries));
  try {
    const data = await _gqlRun(combined, retries);
    items.forEach((x, j) => x.it.resolve({ [x.p.field]: data[`_${j}`] }));
  } catch (e) {
    // Combined failed (a private report, complexity cap, or partial errors _gqlRun
    // throws on) -> bisect so a too-big batch shrinks to the real cap and one bad
    // report doesn't force ALL its batch-mates back to individual requests.
    const mid = items.length >> 1;
    await Promise.all([_runCombinable(items.slice(0, mid)), _runCombinable(items.slice(mid))]);
  }
}

// --- billing probe: settles flat-per-request vs complexity-scaled --------------
// The whole batcher rests on "WCL bills ~flat PER REQUEST". If instead points scale
// with query COMPLEXITY, a combined N-report query costs ~N x a single one and
// batching saves requests/latency but NOT the hourly points budget. This measures it
// directly: run the SAME N report reads two ways -- N separate requests, then ONE
// combined (aliased) request -- reading pointsSpentThisHour around each via WCL's own
// rateLimitData. Identical data both ways, so only the PACKAGING differs:
//   sepCost / combCost ~= N  => FLAT per request (batching is an ~N x points win)
//   sepCost / combCost ~= 1  => COMPLEXITY-scaled (batching saves requests, not points)
// Decisive because the two predictions differ by ~N x, well above the spent-counter's
// few-point settle lag. Raw _gqlRun (bypasses cache) so both arms hit the network.
// Node / connected-browser only (needs a direct WCL token to read rateLimitData).
export async function probeBilling(queries) {
  const items = queries.map((q) => ({ q, p: _splitQuery(q) })).filter((x) => x.p);
  if (items.length < 2) throw new Error("probeBilling needs >=2 combinable queries");
  const spent = async () => { const rl = await rateLimit(); return rl && !rl.limited ? rl.spent : null; };
  const s0 = await spent();
  for (const { q } of items) await _gqlRun(q, 1);                 // arm A: N separate requests
  const s1 = await spent();
  const combined = `query { ${items.map((x, j) => `_${j}: ${x.p.inner}`).join(" ")} }`;
  await _gqlRun(combined, 1);                                     // arm B: 1 combined request
  const s2 = await spent();
  if (s0 == null || s1 == null || s2 == null) return { ok: false, reason: "could not read pointsSpentThisHour (no direct WCL token?)" };
  const n = items.length;
  const sepCost = s1 - s0, combCost = s2 - s1;
  const ratio = combCost > 0 ? sepCost / combCost : null;        // ~N => flat; ~1 => complexity
  const verdict = ratio == null ? "indeterminate (combined cost <= 0 -- counter lag; re-run)"
    : ratio >= n * 0.6 ? `FLAT per request (ratio ${ratio.toFixed(1)} ~ N=${n}) -- batching IS a points win`
    : ratio <= 1.6 ? `COMPLEXITY-scaled (ratio ${ratio.toFixed(1)} ~ 1) -- batching saves requests/latency, NOT points`
    : `unclear (ratio ${ratio.toFixed(1)}, between 1 and N=${n}) -- re-run with larger N`;
  return { ok: true, n, sepCost, combCost, perReqSeparate: sepCost / n, ratio, verdict };
}

// `fresh: true` bypasses every read cache (in-memory, inflight, persistent) and
// does NOT persist the result -- for polling a LIVE report whose fight list is
// still growing during a raid. The immutability heuristic (_isImmutable) keys off
// the query TEXT and can't tell a live report from a finished one, so the
// caller signals freshness instead. Only the report-wide fight-list / deaths
// poll uses it; per-pull TABLES (an ended pull) stay permanently cached as before.
// We still update _gqlCache with the latest result so same-tick non-fresh readers
// downstream see the new fight list rather than a stale one.
export async function gql(query, retries = 6, { fresh = false } = {}) {
  await initDisk();                 // sets up disk paths + runs any one-time migration (Node)
  _ensureLoaded(query);             // lazily decompress just THIS query's shard into _gqlCache
  if (!fresh) {
    if (_gqlCache.has(query)) return _gqlCache.get(query);
    if (_gqlInflight.has(query)) return _gqlInflight.get(query);
  }
  // Build the work as ONE promise before awaiting -- the persistent read is now
  // async (IndexedDB), so doing it outside the inflight map would let concurrent
  // callers all miss the cache and double-fetch. Set inflight synchronously.
  const p = (async () => {
    if (!fresh && PERSIST) {
      const stored = await _cacheRead(query);
      if (stored !== undefined) return stored; // cross-reload hit -- no network
    }
    // Cache-only: every cache read above missed, so a fetch here would spend points.
    // Refuse instead -- the caller wanted a guaranteed-free, cached-only run.
    if (cacheOnly()) throw new CacheMiss(query);
    // Auto-batch concurrent misses into one request (see _enqueueBatched). `fresh`
    // (the live-poll) wants its own immediate fetch; WCL_NO_BATCH lets the logic tests
    // (whose fixed mocks can't model a combined query) see individual requests. Both
    // bypass batching.
    const data = (fresh || _noBatch()) ? await _gqlRun(query, retries) : await _enqueueBatched(query, retries);
    if (!fresh) {
      diskPut(query, data);              // Node CLI disk cache (no-op in the browser)
      if (PERSIST) _cacheWrite(query, data); // browser IndexedDB cache (1h TTL), fire-and-forget
    }
    return data;
  })();
  if (!fresh) _gqlInflight.set(query, p);
  try {
    const data = await p;
    _gqlCache.set(query, data);
    return data;
  } finally {
    if (!fresh) _gqlInflight.delete(query);
  }
}

// Human "when to retry" from a seconds-to-reset, so the thrown error and the live
// UI event phrase the wait IDENTICALLY (no "~3 min" in one place, "shortly" in the
// other). null when we have no clock to report.
export function fmtRateWait(seconds) {
  if (!(seconds > 0)) return null;
  return seconds >= 60 ? `${Math.max(1, Math.ceil(seconds / 60))} min` : `${Math.ceil(seconds)}s`;
}

// --- per-run request accounting (billing diagnostics) -----------------------
// A natural --allow-fetch run counts billable POSTs and the report-UNITS they carry
// (a combined K-report request = 1 request, K units). cli.mjs reads the points spent
// around a run and appends (requests, units, points); across runs, whichever of
// points/request vs points/unit stays CONSTANT reveals the billing basis -- constant
// per-request => flat (batching wins), constant per-unit => complexity (it doesn't).
// Free: rides the loop's existing spend, no separate probe invocation.
let _statRequests = 0, _statUnits = 0;
const _aliasCount = (q) => Math.max(1, (q.match(/(^|\s)_\d+:/g) || []).length);
export function resetRunStats() { _statRequests = 0; _statUnits = 0; }
export function getRunStats() { return { requests: _statRequests, units: _statUnits }; }

// Run a GraphQL query, returning the parsed `data`. Retries transient errors;
// throws PrivateReport on permission errors so callers can skip a report.
async function _gqlRun(query, retries = 6) {
  // Count the billable request + its report-units; skip rateLimitData meta-probes,
  // which would pollute the requests/units ratio the billing fit depends on.
  if (!query.includes("rateLimitData")) { _statRequests++; _statUnits += _aliasCount(query); }
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    let status, j, retryAfter = null;
    try {
      ({ status, j, retryAfter } = IS_NODE ? await nodeWcl(query) : await browserWcl(query));
    } catch (e) {
      if (e instanceof NeedsAuth) throw e; // don't retry -- the user must reconnect
      // Network/transport failure -- worth retrying with backoff.
      last = e;
      if (attempt < retries - 1) await sleep(1000 * (2 + attempt));
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
      // No readable reset yet (a connected session can't see Retry-After)? Ask WCL
      // for the exact reset clock, best-effort, so we can ALWAYS say when to retry
      // rather than a vague "shortly".
      if (!retryAfter && _resetAt <= Date.now()) { try { await primeRateReset(); } catch { /* keep the fallback */ } }
      const eff = retryAfter || (_resetAt > Date.now() ? Math.ceil((_resetAt - Date.now()) / 1000) : null);
      const wait = fmtRateWait(eff);
      const when = wait ? `Try again in ~${wait}` : "Try again shortly";
      // RateLimited carries the exact reset clock so callers (rateLimit(), pacing
      // loops) can wait precisely instead of guessing.
      last = new RateLimited(`WCL rate limit reached — your hourly WCL point budget is used up. ${when}.`, eff);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wcl-ratelimit", { detail: { retryAfter: eff } }));
      // No point sleeping after the final attempt -- we're about to throw `last`.
      // Skipping it lets a single-try status probe (rateLimit) return immediately
      // with the reset info instead of stalling on a 20s backoff.
      if (attempt < retries - 1) await sleep(eff ? Math.min(20000, eff * 1000) : Math.min(12000, 2000 * 2 ** attempt));
      continue;
    }
    if (j.error) throw new Error(j.error); // other non-GraphQL error
    if (!j.data) throw new Error("no data: " + JSON.stringify(j).slice(0, 200));
    return j.data;
  }
  throw last;
}

// ---- Wowhead lookups (tooltips + item XML) ----------------------------------
// Node fetches Wowhead directly; the browser goes through the Worker proxy (which
// CORS-wraps and week-caches them -- Wowhead sends no CORS headers). Coalesces
// concurrent identical fetches within a session and times out hung sockets.
const WOWHEAD_SPELL = "https://nether.wowhead.com/tooltip/spell/";
const WOWHEAD_ZONE = "https://nether.wowhead.com/tooltip/zone/";
const WOWHEAD_NPC = "https://nether.wowhead.com/tooltip/npc/";
const WOWHEAD_ITEM_XML = "https://www.wowhead.com/item=";
const _whInflight = new Map();
async function wowhead(directUrl, workerPath, parse = "json") {
  // Node talks straight to Wowhead (no CORS in Node). The browser always goes
  // through the Worker: Wowhead's tooltip endpoints send no CORS headers, and the
  // Worker's week-long edge cache makes these lookups nearly free and shared.
  const url = IS_NODE ? directUrl : `${WORKER_URL}${workerPath}`;
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
