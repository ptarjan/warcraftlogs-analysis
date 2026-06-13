// The dual-mode client: in Node, gql() talks straight to WCL (OAuth + GraphQL),
// surfaces PrivateReport on permission errors, and coalesces duplicate queries.
import test from "node:test";
import assert from "node:assert/strict";
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
