// Cache keys must be case-agnostic for character lookups: WCL is case-insensitive,
// so "Hadryan"/"hadryan"/"HADRYAN" (and region "US"/"us") are the same character
// and must share ONE fetch -- not pay the quota three times.
process.env.WCL_CLIENT_ID = "x";
process.env.WCL_CLIENT_SECRET = "y";

import test from "node:test";
import assert from "node:assert/strict";

const mk = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o, text: async () => JSON.stringify(o) });

test("character lookups dedupe across name/region casing", async () => {
  const { characterZone } = await import("../docs/core.js");
  const { clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();

  // characterZone now also resolves the current raid zones (one shared, cached query) and
  // then fetches the character's rankings. Route the mock by query type so we can assert
  // the CHARACTER fetch dedupes across casing -- the zone-list fetch is shared regardless.
  let charCalls = 0, zoneListCalls = 0;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("oauth/token")) return mk({ access_token: "t", expires_in: 3600 });
    if (u.includes("/api/v2/")) {
      const body = (opts && opts.body) ? String(opts.body) : "";
      if (body.includes("worldData")) { zoneListCalls++; return mk({ data: { worldData: { zones: [{ id: 9, name: "R", frozen: false, expansion: { id: 1 } }] } } }); }
      charCalls++; return mk({ data: { characterData: { character: { id: 1, classID: 1, z0: { rankings: [] } } } } });
    }
    return mk({});
  };

  await characterZone("Hadryan", "Proudmoore", "US", 5);
  await characterZone("hadryan", "proudmoore", "us", 5); // same character, different case
  await characterZone("HADRYAN", "PROUDMOORE", "Us", 5);
  assert.equal(charCalls, 1, "different-case lookups of the same character must hit the cache, not refetch");
  assert.equal(zoneListCalls, 1, "the current-raid-zones list is fetched once and shared");
});
