// Test backstop: forbid real network in the test runner so we never hit the
// live Worker / WCL and never spend rate limits. Preloaded into every test
// process via `node --import ./test/setup.mjs` (see package.json "test").
//
// Tests that need responses install mockFetch() (test/helpers.mjs), which
// overrides this for the specific routes they exercise. Anything unmocked
// throws loudly here instead of going to the network.
globalThis.fetch = async (url) => {
  throw new Error(
    `Blocked a real network fetch in tests: ${url}\n` +
    "Tests must mock fetch (test/helpers.mjs mockFetch) — no live site / WCL rate limits."
  );
};
