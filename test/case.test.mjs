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

  let apiCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("oauth/token")) return mk({ access_token: "t", expires_in: 3600 });
    if (u.includes("/api/v2/")) { apiCalls++; return mk({ data: { characterData: { character: { id: 1, classID: 1, zoneRankings: { rankings: [] } } } } }); }
    return mk({});
  };

  await characterZone("Hadryan", "Proudmoore", "US", 5);
  await characterZone("hadryan", "proudmoore", "us", 5); // same character, different case
  await characterZone("HADRYAN", "PROUDMOORE", "Us", 5);
  assert.equal(apiCalls, 1, "different-case lookups of the same character must hit the cache, not refetch");
});
