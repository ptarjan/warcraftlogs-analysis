// Shared test helpers: a localStorage shim and a routing fetch mock, so the
// browser modules run under Node's test runner with no network.

export function installLocalStorage() {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  return store;
}

// routes: array of [urlSubstring, respOrFn]. resp = { status?, json }.
// Returns a fetch() stand-in with a `.calls` array for assertions.
export function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    for (const [pat, resp] of routes) {
      if (u.includes(pat)) {
        const body = typeof resp === "function" ? resp(u, opts) : resp;
        const status = body.status ?? 200;
        return {
          ok: status < 400,
          status,
          headers: { get: () => null },
          json: async () => body.json,
          text: async () => JSON.stringify(body.json),
        };
      }
    }
    throw new Error("no mock route for " + u);
  };
  fn.calls = calls;
  return fn;
}

export const tooltip = (name, html, status = 200) => ({ status, json: { name, tooltip: html } });
