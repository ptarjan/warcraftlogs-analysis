// raidTeammates(): from your own kills' report rosters, surface the players you
// most often raid with -- counting shared kills, excluding yourself and pets,
// sorted most-frequent-first. Documents the masterData.actors shape it reads.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage, mockFetch } from "./helpers.mjs";

installLocalStorage();
process.env.WCL_CLIENT_ID = "test-id";
process.env.WCL_CLIENT_SECRET = "test-secret";

const TOKEN = ["oauth/token", { json: { access_token: "tok", expires_in: 3600 } }];

// Route /api/v2/client by inspecting the GraphQL query text: your killed bosses,
// your kills' report codes, then each report's player roster.
function wclRoute(rosters) {
  return ["/api/v2/client", (_u, opts) => {
    const q = JSON.parse(opts.body).query;
    if (/zoneRankings/.test(q)) {
      // Only difficulty 5 (Mythic) has kills; lower difficulties return none.
      const has5 = /difficulty:5/.test(q);
      return { json: { data: { characterData: { character: {
        zoneRankings: { rankings: has5 ? [{ encounter: { id: 1, name: "B1" }, totalKills: 2 }] : [] } } } } } };
    }
    if (/encounterRankings/.test(q)) {
      return { json: { data: { characterData: { character: { encounterRankings: {
        ranks: [{ report: { code: "R1" } }, { report: { code: "R2" } }] } } } } } };
    }
    if (/masterData/.test(q)) {
      const code = (q.match(/code:"(\w+)"/) || [])[1];
      return { json: { data: { reportData: { report: { masterData: { actors: rosters[code] || [] } } } } } };
    }
    return { json: { data: {} } };
  }];
}

test("raidTeammates: shared-kill tally, excludes self + pets, sorted", async () => {
  const { raidTeammates } = await import("../docs/core.js");
  const { clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  const rosters = {
    R1: [
      { name: "Me", server: "Proudmoore", type: "Player" },
      { name: "Tank", server: "Proudmoore", type: "Player" },
      { name: "Healer", server: "Area 52", type: "Player" },
      { name: "Critter", server: "Proudmoore", type: "Pet" }, // not a Player -> dropped
    ],
    R2: [
      { name: "Me", server: "Proudmoore", type: "Player" },
      { name: "Tank", server: "Proudmoore", type: "Player" },
      { name: "Mage", server: "Proudmoore", type: "Player" },
    ],
  };
  globalThis.fetch = mockFetch([TOKEN, wclRoute(rosters)]);
  const mates = await raidTeammates("Me", "proudmoore", "US");

  assert.equal(mates.find((m) => m.name === "Me"), undefined, "excludes yourself");
  assert.equal(mates.find((m) => m.name === "Critter"), undefined, "excludes pets");
  assert.deepEqual(mates[0], { name: "Tank", server: "Proudmoore", region: "US", shared: 2 },
    "most-shared teammate first, carrying the realm NAME for the caller to slug");
  assert.equal(mates.length, 3);            // Tank, Healer, Mage
  assert.ok(mates.every((m) => m.region === "US")); // same region as you
});

test("raidTeammates: no kills -> empty (never throws)", async () => {
  const { raidTeammates } = await import("../docs/core.js");
  const { clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { characterData: {
    character: { zoneRankings: { rankings: [] } } } } } }]]);
  assert.deepEqual(await raidTeammates("Nobody", "proudmoore", "US"), []);
});
