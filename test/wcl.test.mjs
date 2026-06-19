// The dual-mode client: in Node, gql() talks straight to WCL (OAuth + GraphQL),
// surfaces PrivateReport on permission errors, and coalesces duplicate queries.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installLocalStorage, mockFetch } from "./helpers.mjs";

installLocalStorage();
process.env.WCL_CLIENT_ID = "test-id";
process.env.WCL_CLIENT_SECRET = "test-secret";

const TOKEN = ["oauth/token", { json: { access_token: "tok", expires_in: 3600 } }];

test("gql returns data via the direct WCL path", async () => {
  const { gql, clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { hello: "world" } } }]]);
  assert.deepEqual(await gql("query{ a }"), { hello: "world" });
});

test("permission errors raise PrivateReport (so callers can skip)", async () => {
  const { gql, clearGqlCache, PrivateReport } = await import("../docs/wcl.js");
  clearGqlCache();
  globalThis.fetch = mockFetch([TOKEN,
    ["/api/v2/client", { json: { errors: [{ message: "you do not have permission" }] } }]]);
  await assert.rejects(() => gql("query{ b }"), (e) => e instanceof PrivateReport);
});

test("gql auto-batches concurrent cache-misses into ONE combined request, split back per caller", async () => {
  const { gql, clearGqlCache } = await import("../docs/wcl.js");
  const saved = process.env.WCL_NO_BATCH;
  const r = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o, text: async () => JSON.stringify(o) });
  try {
    delete process.env.WCL_NO_BATCH;   // enable batching for this test
    clearGqlCache();
    const apiBodies = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("oauth/token")) return r({ access_token: "t", expires_in: 3600 });
      const q = JSON.parse(opts.body).query; apiBodies.push(q);
      // Respond to a combined query by shaping each _N alias from its report code.
      const aliases = [...q.matchAll(/_(\d+):\s*reportData\s*\{\s*report\(code:"([^"]+)"/g)];
      if (aliases.length) { const data = {}; for (const [, n, code] of aliases) data[`_${n}`] = { report: { code } }; return r({ data }); }
      const code = (q.match(/report\(code:"([^"]+)"/) || [])[1];
      return r({ data: { reportData: { report: { code } } } });
    };
    const [a, b, c] = await Promise.all([
      gql('query { reportData { report(code:"A") { x } } }'),
      gql('query { reportData { report(code:"B") { x } } }'),
      gql('query { reportData { report(code:"C") { x } } }'),
    ]);
    assert.equal(apiBodies.filter((q) => /reportData/.test(q)).length, 1, "3 concurrent misses -> 1 combined request");
    assert.deepEqual(a, { reportData: { report: { code: "A" } } }, "caller A gets ITS report");
    assert.deepEqual(b, { reportData: { report: { code: "B" } } });
    assert.deepEqual(c, { reportData: { report: { code: "C" } } });
  } finally {
    if (saved === undefined) delete process.env.WCL_NO_BATCH; else process.env.WCL_NO_BATCH = saved;
    clearGqlCache();
  }
});

test("a failing combined batch BISECTS (isolates the bad report) instead of dropping all to individual", async () => {
  const { gql, clearGqlCache } = await import("../docs/wcl.js");
  const saved = process.env.WCL_NO_BATCH;
  const r = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o, text: async () => JSON.stringify(o) });
  try {
    delete process.env.WCL_NO_BATCH;   // enable batching
    clearGqlCache();
    const combinedSizes = [];          // # of aliases in each combined request we see
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("oauth/token")) return r({ access_token: "t", expires_in: 3600 });
      const q = JSON.parse(opts.body).query;
      const aliases = [...q.matchAll(/_(\d+):\s*reportData\s*\{\s*report\(code:"([^"]+)"/g)];
      if (aliases.length) {
        combinedSizes.push(aliases.length);
        // Report "BAD" poisons any combined request it's in (like a private report /
        // partial error _gqlRun throws on) -> forces a bisect.
        if (aliases.some(([, , code]) => code === "BAD")) return r({ errors: [{ message: "no access" }] });
        const data = {}; for (const [, n, code] of aliases) data[`_${n}`] = { report: { code } };
        return r({ data });
      }
      const code = (q.match(/report\(code:"([^"]+)"/) || [])[1];
      if (code === "BAD") return r({ errors: [{ message: "no access" }] });
      return r({ data: { reportData: { report: { code } } } });
    };
    const codes = ["A", "BAD", "C", "D"];
    const results = await Promise.allSettled(codes.map((c) =>
      gql(`query { reportData { report(code:"${c}") { x } } }`)));
    // The 3 good reports still resolve (their halves combine fine); only BAD rejects.
    assert.deepEqual(results.map((x) => x.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    assert.deepEqual(results[0].value, { reportData: { report: { code: "A" } } });
    // Bisected, NOT dropped to 4 individual: we should have seen at least one combined
    // request of size > 1 succeed (the good half), proving graceful degradation.
    assert.ok(combinedSizes.some((s) => s > 1), `expected a surviving multi-report batch, saw sizes ${combinedSizes}`);
  } finally {
    if (saved === undefined) delete process.env.WCL_NO_BATCH; else process.env.WCL_NO_BATCH = saved;
    clearGqlCache();
  }
});

test("rateLimit surfaces the EXACT reset on a 429 (not bare null), so callers wait precisely", async () => {
  const { rateLimit, clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  // A 429 with a Retry-After header -- the direct-CLI path reads it for the clock.
  globalThis.fetch = mockFetch([TOKEN,
    ["/api/v2/client", { status: 429, headers: { "retry-after": 137 }, json: {} }]]);
  const r = await rateLimit();
  assert.ok(r, "must not be null -- the reset clock is known");
  assert.equal(r.limited, true);
  assert.equal(r.remaining, 0);
  assert.equal(r.resetIn, 137);                 // exact seconds, not a guess
});

test("rateLimit reports a healthy budget with limited:false and the real resetIn", async () => {
  const { rateLimit, clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client",
    { json: { data: { rateLimitData: { limitPerHour: 3600, pointsSpentThisHour: 600, pointsResetIn: 1800 } } } }]]);
  const r = await rateLimit();
  assert.equal(r.limited, false);
  assert.equal(r.remaining, 3000);
  assert.equal(r.resetIn, 1800);
});

const budgetMock = (remaining, resetIn = 1800) => mockFetch([TOKEN, ["/api/v2/client",
  { json: { data: { rateLimitData: { limitPerHour: 3600, pointsSpentThisHour: 3600 - remaining, pointsResetIn: resetIn } } } }]]);

test("acquireFetchLock: only ONE process holds it; release frees it; dead/stale owners are stolen", async () => {
  const { acquireFetchLock } = await import("../docs/wcl.js");
  const lockFile = path.join(os.tmpdir(), `wcl-lock-test-${process.pid}.json`);
  process.env.WCL_GQL_CACHE_FILE = lockFile;                 // lock lives next to the cache file
  const lockPath = path.join(path.dirname(lockFile), "fetch.lock");
  try {
    fs.rmSync(lockPath, { force: true });
    const rel1 = await acquireFetchLock();
    assert.ok(rel1, "first acquirer gets the lock");
    assert.equal(await acquireFetchLock(), null, "second concurrent acquirer is denied");
    rel1();
    const rel2 = await acquireFetchLock();
    assert.ok(rel2, "after release the lock is available again");
    rel2();
    // A lock owned by a DEAD pid is stolen.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, t: Date.now() }));
    const rel3 = await acquireFetchLock();
    assert.ok(rel3, "a dead owner's lock is stolen");
    rel3();
    // A STALE lock (old timestamp, even if pid looks alive) is stolen.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, t: Date.now() - 60 * 60 * 1000 }));
    const rel4 = await acquireFetchLock({ staleMs: 15 * 60 * 1000 });
    assert.ok(rel4, "a stale lock is stolen");
    rel4();
  } finally {
    delete process.env.WCL_GQL_CACHE_FILE;
    fs.rmSync(lockPath, { force: true });
  }
});

test("acquireFetchGate: denies below the reserve, allows above it", async () => {
  const { acquireFetchGate, clearGqlCache } = await import("../docs/wcl.js");
  const lockFile = path.join(os.tmpdir(), `wcl-gate-test-${process.pid}.json`);
  process.env.WCL_GQL_CACHE_FILE = lockFile;
  const lockPath = path.join(path.dirname(lockFile), "fetch.lock");
  try {
    fs.rmSync(lockPath, { force: true });
    // Below reserve -> denied, no lock taken.
    clearGqlCache(); globalThis.fetch = budgetMock(100);
    const low = await acquireFetchGate({ reserve: 400 });
    assert.equal(low.ok, false);
    assert.match(low.reason, /reserve/);
    assert.equal(fs.existsSync(lockPath), false, "no lock taken when denied");
    // Above reserve -> allowed, lock taken, then released.
    clearGqlCache(); globalThis.fetch = budgetMock(2000);
    const ok = await acquireFetchGate({ reserve: 400 });
    assert.equal(ok.ok, true);
    assert.equal(ok.remaining, 2000);
    assert.ok(fs.existsSync(lockPath), "lock held while fetching");
    ok.release();
  } finally {
    delete process.env.WCL_GQL_CACHE_FILE;
    fs.rmSync(lockPath, { force: true });
  }
});

test("concurrent identical queries are coalesced into one request", async () => {
  const { gql, clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  const fx = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { n: 1 } } }]]);
  globalThis.fetch = fx;
  const q = "query{ coalesce }";
  const [a, b] = await Promise.all([gql(q), gql(q)]);
  assert.deepEqual(a, b);
  const apiCalls = fx.calls.filter((c) => c.url.includes("/api/v2/client")).length;
  assert.equal(apiCalls, 1, "duplicate concurrent queries should share one API call");
});

// The Node-only on-disk cache: a second run reuses the first run's results
// instead of re-hitting WCL (which is what trips the per-IP 429 throttle).
test("disk cache: a fresh run serves persisted results without a new request", async () => {
  const { gql, clearGqlCache, _flushGqlDisk, _resetGqlDisk } = await import("../docs/wcl.js");
  const file = path.join(os.tmpdir(), `wcl-gql-cache-test-${process.pid}.json`);
  try { fs.rmSync(file, { force: true }); } catch { /* none */ }
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  const q = "query{ persisted }";
  try {
    // First "run": fetch once, then flush + forget all in-memory state.
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { v: 42 } } }]]);
    assert.deepEqual(await gql(q), { v: 42 });
    _flushGqlDisk();

    // Second "run": same query, but any network call now throws -- the answer
    // must come from the cache file written by the first run.
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = () => { throw new Error("must not hit the network on a cache hit"); };
    assert.deepEqual(await gql(q), { v: 42 });
  } finally {
    delete process.env.WCL_GQL_CACHE;
    delete process.env.WCL_GQL_CACHE_FILE;
    _resetGqlDisk();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
});

// Report data (a specific logged kill) is immutable -> it must NEVER age out of the
// disk cache, even when a rankings entry written at the same time would have.
test("disk cache: immutable report data never expires; rankings do", async () => {
  const { gql, clearGqlCache, _flushGqlDisk, _resetGqlDisk } = await import("../docs/wcl.js");
  const file = path.join(os.tmpdir(), `wcl-gql-immutable-test-${process.pid}.json`);
  try { fs.rmSync(file, { force: true }); } catch { /* none */ }
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  const reportQ = 'query { reportData { report(code:"abcd") { events(fightIDs:1) { data } } } }';
  const rankingsQ = "query { worldData { encounter(id:1) { characterRankings(page:1) } } }";
  try {
    // Seed both as if written 30 days ago (older than the weekly rankings TTL).
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify({
      [reportQ]: { t: old, d: { report: "kept" } },
      [rankingsQ]: { t: old, d: { ranks: "stale" } },
    }));
    clearGqlCache(); _resetGqlDisk();
    // Report query: served from the ancient cache entry, no network.
    globalThis.fetch = () => { throw new Error("immutable report data must not refetch"); };
    assert.deepEqual(await gql(reportQ), { report: "kept" });

    // Rankings query: the 30-day-old entry is expired, so it refetches.
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { ranks: "fresh" } } }]]);
    assert.deepEqual(await gql(rankingsQ), { ranks: "fresh" }, "stale rankings refetch");
  } finally {
    delete process.env.WCL_GQL_CACHE;
    delete process.env.WCL_GQL_CACHE_FILE;
    _resetGqlDisk();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(`${file}.shards`, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// THE TRUNCATION GUARD: a shard that exists but can't be read/parsed must be
// PRESERVED, never overwritten with only-our-slice. (On the old monolith, the
// missing guard wiped the shared 396MB cache down to 38MB.)
test("disk cache: an unreadable shard is preserved, not clobbered", async () => {
  const { gql, clearGqlCache, _flushGqlDisk, _resetGqlDisk, _shardId } = await import("../docs/wcl.js");
  const file = path.join(os.tmpdir(), `wcl-noclobber-${process.pid}.json`);
  const dir = `${file}.shards`;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  const q = "query{ collide }";
  try {
    fs.mkdirSync(dir, { recursive: true });
    const shardFile = path.join(dir, `${_shardId(q)}.json.gz`);  // the real write target
    fs.writeFileSync(shardFile, "{ this is not valid json");   // a corrupt/unreadable shard
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { v: 1 } } }]]);
    await gql(q);                 // fetch + put into that shard
    _flushGqlDisk();              // one flush: must NOT overwrite the unreadable shard
    assert.equal(fs.readFileSync(shardFile, "utf8"), "{ this is not valid json", "unreadable shard preserved");
  } finally {
    delete process.env.WCL_GQL_CACHE; delete process.env.WCL_GQL_CACHE_FILE; _resetGqlDisk();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// A legacy monolithic cache file is read, distributed into shards, and removed.
test("disk cache: migrates a legacy monolith into shards, then removes it", async () => {
  const { gql, clearGqlCache, _flushGqlDisk, _resetGqlDisk } = await import("../docs/wcl.js");
  const file = path.join(os.tmpdir(), `wcl-migrate-${process.pid}.json`);
  const dir = `${file}.shards`;
  try { fs.rmSync(file, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  const reportQ = 'query { reportData { report(code:"mig") { events(fightIDs:1) { data } } } }';
  try {
    fs.writeFileSync(file, JSON.stringify({ [reportQ]: { t: Date.now(), d: { kept: true } } }));
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = () => { throw new Error("migrated entry must not refetch"); };
    assert.deepEqual(await gql(reportQ), { kept: true }, "served from the legacy monolith");
    _flushGqlDisk();
    assert.equal(fs.existsSync(file), false, "monolith removed after migration");
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith(".json.gz")), "entry written into a gzipped shard");
    // A fresh run serves it from the shard, no monolith, no network.
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = () => { throw new Error("must come from the shard"); };
    assert.deepEqual(await gql(reportQ), { kept: true });
  } finally {
    delete process.env.WCL_GQL_CACHE; delete process.env.WCL_GQL_CACHE_FILE; _resetGqlDisk();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Shards are gzipped on disk (~7x smaller), and a legacy PLAIN .json shard is still
// read and then rewritten compressed (the .endsWith(".json") sniff + dual-format read).
// ADDITIVE RESHARD (2-hex -> 3-hex): the existing on-disk cache (and other worktrees
// still on 2-hex code) must keep working. New code reads the 2-hex shard as a fallback,
// migrates the entry into its 3-hex shard, and NEVER deletes the 2-hex shard.
test("disk cache: reads a legacy 2-hex shard via fallback, migrates to 3-hex, keeps the old one", async () => {
  const { gql, clearGqlCache, _flushGqlDisk, _resetGqlDisk, _shardId, _oldShardId } = await import("../docs/wcl.js");
  const file = path.join(os.tmpdir(), `wcl-reshard-${process.pid}.json`);
  const dir = `${file}.shards`;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
  fs.mkdirSync(dir, { recursive: true });
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  const q = "query{ reshard-me }";
  try {
    clearGqlCache(); _resetGqlDisk();
    // Pre-seed ONLY the legacy 2-hex shard (plain JSON content -- _decodeShard sniffs the
    // gzip magic, so uncompressed is read fine), as old code would have left it.
    const oldPath = path.join(dir, `${_oldShardId(q)}.json.gz`);
    assert.notEqual(_shardId(q), _oldShardId(q), "3-hex and 2-hex ids differ");
    fs.writeFileSync(oldPath, JSON.stringify({ [q]: { t: Date.now(), d: { v: 42 } } }));
    // New code SERVES it from the 2-hex fallback (no fetch)...
    globalThis.fetch = () => { throw new Error("must read the legacy 2-hex shard, not fetch"); };
    assert.deepEqual(await gql(q), { v: 42 }, "served from the 2-hex fallback shard");
    // ...and migrates it into the 3-hex shard WITHOUT deleting the 2-hex one.
    _flushGqlDisk();
    assert.ok(fs.existsSync(path.join(dir, `${_shardId(q)}.json.gz`)), "migrated into a 3-hex shard");
    assert.ok(fs.existsSync(oldPath), "legacy 2-hex shard NOT deleted (old worktrees still read it)");
  } finally {
    delete process.env.WCL_GQL_CACHE; delete process.env.WCL_GQL_CACHE_FILE; _resetGqlDisk();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("disk cache: shards are gzipped; legacy plain shards are read and recompressed", async () => {
  const { gql, clearGqlCache, _flushGqlDisk, _resetGqlDisk, _shardId } = await import("../docs/wcl.js");
  const file = path.join(os.tmpdir(), `wcl-gzip-${process.pid}.json`);
  const dir = `${file}.shards`;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  const q = "query{ gzip-me }";
  try {
    // A fetched query persists as a gzipped .json.gz shard (gzip magic 1f 8b).
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { v: 7 } } }]]);
    await gql(q); _flushGqlDisk();
    const gzPath = path.join(dir, `${_shardId(q)}.json.gz`);
    const bytes = fs.readFileSync(gzPath);
    assert.ok(bytes[0] === 0x1f && bytes[1] === 0x8b, "shard is gzip-compressed");

    // A legacy PLAIN .json shard (pre-compression code) is still read...
    clearGqlCache(); _resetGqlDisk();
    const legacyQ = "query{ legacy-plain }";
    fs.writeFileSync(path.join(dir, `${_shardId(legacyQ)}.json`),
      JSON.stringify({ [legacyQ]: { t: Date.now(), d: { v: 9 } } }));
    globalThis.fetch = () => { throw new Error("must read the legacy plain shard, not fetch"); };
    assert.deepEqual(await gql(legacyQ), { v: 9 }, "legacy plain .json shard is read");
    // ...and on flush it's recompressed to .json.gz, the plain one removed.
    _flushGqlDisk();
    assert.ok(fs.existsSync(path.join(dir, `${_shardId(legacyQ)}.json.gz`)), "rewritten as .json.gz");
    assert.equal(fs.existsSync(path.join(dir, `${_shardId(legacyQ)}.json`)), false, "legacy .json removed");
  } finally {
    delete process.env.WCL_GQL_CACHE; delete process.env.WCL_GQL_CACHE_FILE; _resetGqlDisk();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// preferCache: when the player is unchanged (or fetching is off), serve the cached field
// PAST its weekly TTL instead of re-spending points -- but only up to the ~month stale cap.
test("disk cache: preferCache reuses an expired field within the cap, refetches past it", async () => {
  const { gql, clearGqlCache, _resetGqlDisk, _shardId, setPreferCache } = await import("../docs/wcl.js");
  const zlib = await import("node:zlib");
  const file = path.join(os.tmpdir(), `wcl-prefer-${process.pid}.json`);
  const dir = `${file}.shards`;
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  const rankingsQ = "query { worldData { encounter(id:7) { characterRankings(page:1) } } }";
  const DAY = 24 * 60 * 60 * 1000;
  const seed = (ageMs, d) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* none */ }
    fs.mkdirSync(dir, { recursive: true });
    const shard = path.join(dir, `${_shardId(rankingsQ)}.json.gz`);
    fs.writeFileSync(shard, zlib.gzipSync(JSON.stringify({ [rankingsQ]: { t: Date.now() - ageMs, d } })));
  };
  try {
    // 14 days old: past the weekly TTL, within the 28-day cap. preferCache OFF -> refetch.
    setPreferCache(false);
    seed(14 * DAY, { ranks: "stale14" });
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { ranks: "fresh" } } }]]);
    assert.deepEqual(await gql(rankingsQ), { ranks: "fresh" }, "off: expired field refetches");

    // Same age, preferCache ON -> serve the stale field, no network.
    setPreferCache(true);
    seed(14 * DAY, { ranks: "stale14" });
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = () => { throw new Error("preferCache must reuse the within-cap stale field"); };
    assert.deepEqual(await gql(rankingsQ), { ranks: "stale14" }, "on: within-cap field reused");

    // 30 days old (past the cap), preferCache ON -> still refetches (field can't drift forever).
    seed(30 * DAY, { ranks: "stale30" });
    clearGqlCache(); _resetGqlDisk();
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { ranks: "fresh2" } } }]]);
    assert.deepEqual(await gql(rankingsQ), { ranks: "fresh2" }, "on: past-cap field still refetches");
  } finally {
    setPreferCache(false);
    delete process.env.WCL_GQL_CACHE;
    delete process.env.WCL_GQL_CACHE_FILE;
    _resetGqlDisk();
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// revalidateCharacter: the kill-signature gate. First sight stores the signature and does
// NOT reuse; an unchanged signature flips preferCache on so the field is reused next time.
test("revalidateCharacter: unchanged kills -> reuse the field (preferCache on)", async () => {
  const { revalidateCharacter } = await import("../docs/core.js");
  const { clearGqlCache, _resetGqlDisk, setPreferCache, preferCache } = await import("../docs/wcl.js");
  const zoneResp = (kills) => ({ data: { characterData: { character: {
    id: 1, classID: 10, zoneRankings: { rankings: [{ encounter: { id: 1 }, totalKills: kills }] } } } } });
  try {
    clearGqlCache(); _resetGqlDisk(); setPreferCache(false);
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: zoneResp(3) }]]);
    const first = await revalidateCharacter("Foo", "bar", "US", 5);
    assert.equal(first.unchanged, false, "first sight: no prior signature -> don't reuse");
    assert.equal(preferCache(), false, "first sight leaves the normal TTL in charge");

    // Second run, same kills (zoneRankings now served from cache): signature matches.
    const second = await revalidateCharacter("Foo", "bar", "US", 5);
    assert.equal(second.unchanged, true, "same kills -> unchanged -> reuse the field");
    assert.equal(preferCache(), true, "unchanged -> preferCache flipped on");
  } finally {
    setPreferCache(false); clearGqlCache(); _resetGqlDisk();
  }
});

// LRU eviction: the cache is bounded by SIZE and evicts the least-recently-ACCESSED shards
// (by file mtime), never by age. Over the budget, the oldest-mtime shards go first; recently
// touched ones survive. Replaces the old time-based retention so review never lapses on a timer.
test("disk cache: LRU evicts least-recently-accessed shards over the size budget", async () => {
  const { gql, _resetGqlDisk, _flushGqlDisk, _evictGqlLru } = await import("../docs/wcl.js");
  const file = path.join(os.tmpdir(), `wcl-lru-${process.pid}.json`);
  const dir = `${file}.shards`;
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = file;
  process.env.WCL_CACHE_MAX_MB = "1";   // 1 MB budget
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    _resetGqlDisk();
    // A fetch initialises the disk machinery (_diskDir/_diskFs/_diskPath) + writes a shard.
    globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { ok: 1 } } }]]);
    await gql("query { worldData { encounter(id:99) { characterRankings(page:1) } } }");
    _flushGqlDisk();
    // 5 real-size shards (~400 KB each = ~2 MB > the 1 MB budget): 3 cold (old mtime), 2 hot.
    const now = Date.now();
    const mk = (name, ageDays) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.alloc(400 * 1024));
      const t = (now - ageDays * 86400000) / 1000;
      fs.utimesSync(p, t, t);
    };
    mk("a00.json.gz", 30); mk("a01.json.gz", 20); mk("a02.json.gz", 10);   // cold
    mk("f00.json.gz", 0.10); mk("f01.json.gz", 0.05);                       // hot (recent)
    _evictGqlLru();
    const left = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz")));
    assert.ok(left.has("f00.json.gz") && left.has("f01.json.gz"), "recently-accessed shards survive");
    assert.ok(!left.has("a00.json.gz"), "oldest-mtime shard evicted first");
    // Total left must be under the budget (1 MB).
    let total = 0; for (const f of left) total += fs.statSync(path.join(dir, f)).size;
    assert.ok(total <= 1024 * 1024, `cache pruned under the budget (got ${total})`);
  } finally {
    delete process.env.WCL_GQL_CACHE; delete process.env.WCL_GQL_CACHE_FILE; delete process.env.WCL_CACHE_MAX_MB;
    _resetGqlDisk();
    fs.rmSync(file, { force: true }); fs.rmSync(dir, { recursive: true, force: true });
  }
});
