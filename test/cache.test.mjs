// The persistent (cross-reload) query cache. Backed by IndexedDB in the browser;
// under Node it falls back to an in-memory map, which is what these exercise.
// WCL_PERSIST_TEST=1 forces gql() to use it under Node so we can prove the
// cross-reload behavior empirically. Must be set BEFORE importing wcl.js (PERSIST
// is evaluated at module load).
process.env.WCL_PERSIST_TEST = "1";
process.env.WCL_CLIENT_ID = "test-id";
process.env.WCL_CLIENT_SECRET = "test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import { mockFetch } from "./helpers.mjs";

const TOKEN = ["oauth/token", { json: { access_token: "tok", expires_in: 3600 } }];

test("the cache round-trips, misses cleanly, and keeps large values", async () => {
  const { _cacheRead, _cacheWrite } = await import("../docs/wcl.js");
  await _cacheWrite("query{ a }", { hello: "world" });
  assert.deepEqual(await _cacheRead("query{ a }"), { hello: "world" });
  assert.equal(await _cacheRead("query{ never-written }"), undefined);
  const big = { blob: "z".repeat(500 * 1024) }; // no per-entry size cap any more
  await _cacheWrite("query{ big }", big);
  assert.deepEqual(await _cacheRead("query{ big }"), big);
});

test("a fetched query is served from the cache on the next reload (no 2nd fetch)", async () => {
  const { gql, clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  const q = "query{ reload-me }";

  // First load: one network fetch, result gets persisted.
  const fx = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { n: 42 } } }]]);
  globalThis.fetch = fx;
  assert.deepEqual(await gql(q), { n: 42 });
  const firstCalls = fx.calls.filter((c) => c.url.includes("/api/v2/client")).length;
  assert.equal(firstCalls, 1, "first load fetches once");

  // Simulate a reload: the in-memory cache is gone, the persistent store survives.
  clearGqlCache();
  globalThis.fetch = async () => { throw new Error("must NOT hit the network on reload"); };
  assert.deepEqual(await gql(q), { n: 42 }, "served from the persistent cache, no fetch");
});

test("gql({fresh}) bypasses every read cache and re-fetches (live-report poll)", async () => {
  const { gql, clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  const q = "query{ live-report }";
  let n = 0;
  globalThis.fetch = (() => {
    const f = async (url) => {
      if (String(url).includes("oauth/token")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
      n++;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { n } }), text: async () => "" };
    };
    return f;
  })();
  // A normal call caches; a second normal call is served from cache (no re-fetch).
  assert.deepEqual(await gql(q), { n: 1 });
  assert.deepEqual(await gql(q), { n: 1 }, "cached");
  // fresh:true ignores the cache and hits the network again (the live fight list grew).
  assert.deepEqual(await gql(q, 6, { fresh: true }), { n: 2 }, "fresh bypasses the cache");
  // It also does NOT poison the cache for a later non-fresh reader -- but DOES make
  // the latest value visible (we update _gqlCache so downstream sees the new list).
  assert.deepEqual(await gql(q), { n: 2 }, "latest fresh value is visible to non-fresh readers");
});
