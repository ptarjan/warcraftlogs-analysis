// Test backstop: forbid real network in the test runner so we never hit the
// live Worker / WCL and never spend rate limits. Preloaded into every test
// process via `node --import ./test/setup.mjs` (see package.json "test").
//
// Tests that need responses install mockFetch() (test/helpers.mjs), which
// overrides this for the specific routes they exercise. Anything unmocked
// throws loudly here instead of going to the network.
// Tests are authorized "fetchers": gql() now defaults to cache-only under Node
// (fetching is opt-in via WCL_ALLOW_FETCH), so without this the fetch-path tests
// would throw CacheMiss before reaching their mocked fetch. The mock below still
// blocks any UNmocked network call. (The cache-only test sets WCL_CACHE_ONLY=1 to
// force read-only and override this.)
process.env.WCL_ALLOW_FETCH = "1";
// gql() auto-batches concurrent requests into one combined GraphQL query in prod.
// Most tests use FIXED mock responses that can't model a combined (aliased) query, so
// disable batching by default -- they see individual requests. The loader test (which
// has an alias-aware mock) and the dedicated batcher test opt back IN to verify it.
process.env.WCL_NO_BATCH = "1";

globalThis.fetch = async (url) => {
  throw new Error(
    `Blocked a real network fetch in tests: ${url}\n` +
    "Tests must mock fetch (test/helpers.mjs mockFetch) — no live site / WCL rate limits."
  );
};
