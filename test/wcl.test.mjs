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
  }
});
