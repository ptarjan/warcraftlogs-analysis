// raidTeammates(): from your own kills' report rosters, surface the players you
// most often raid with -- counting shared kills, excluding yourself and pets,
// sorted most-frequent-first. WCL renders an actor's "server" as either a bare
// string or a {name,region} object depending on the schema, so the query tries
// both selections; these tests pin both shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage, mockFetch } from "./helpers.mjs";

installLocalStorage();
process.env.WCL_CLIENT_ID = "test-id";
process.env.WCL_CLIENT_SECRET = "test-secret";

const TOKEN = ["oauth/token", { json: { access_token: "tok", expires_in: 3600 } }];

// Route /api/v2/client by inspecting the GraphQL query text. `shape` controls how
// the mocked WCL renders actor.server: as a string, or as a {name,region} object
// (in which case the scalar `server` selection errors, forcing the fallback).
function wclRoute(rosters, shape = "string") {
  return ["/api/v2/client", (_u, opts) => {
    const q = JSON.parse(opts.body).query;
    if (/zoneRankings/.test(q)) {
      const has5 = /difficulty:5/.test(q);
      return { json: { data: { characterData: { character: {
        zoneRankings: { rankings: has5 ? [{ encounter: { id: 1, name: "B1" }, totalKills: 2 }] : [] } } } } } };
    }
    if (/encounterRankings/.test(q)) {
      return { json: { data: { characterData: { character: { encounterRankings: {
        ranks: [{ report: { code: "R1" } }, { report: { code: "R2" } }] } } } } } };
    }
    if (/masterData/.test(q)) {
      const objSel = /server\s*\{/.test(q);
      if (shape === "object" && !objSel)            // scalar selection on an object field -> error
        return { json: { errors: [{ message: "Field 'server' must have a selection of subfields" }] } };
      const code = (q.match(/code:"(\w+)"/) || [])[1];
      const actors = (rosters[code] || []).map((a) => shape === "object"
        ? { name: a.name, type: a.type, server: a.server ? { name: a.server, region: "US" } : null }
        : a);
      return { json: { data: { reportData: { report: { masterData: { actors } } } } } };
    }
    return { json: { data: {} } };
  }];
}

const ROSTERS = {
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

async function load() {
  const { raidTeammates } = await import("../docs/core.js");
  const { clearGqlCache } = await import("../docs/wcl.js");
  clearGqlCache();
  return raidTeammates;
}

test("raidTeammates: tally / exclude self+pets / sort (server as string)", async () => {
  const raidTeammates = await load();
  globalThis.fetch = mockFetch([TOKEN, wclRoute(ROSTERS, "string")]);
  const mates = await raidTeammates("Me", "proudmoore", "US");
  assert.equal(mates.find((m) => m.name === "Me"), undefined, "excludes yourself");
  assert.equal(mates.find((m) => m.name === "Critter"), undefined, "excludes pets");
  assert.deepEqual(mates[0], { name: "Tank", server: "Proudmoore", region: "US", shared: 2 });
  assert.equal(mates.length, 3); // Tank, Healer, Mage
});

test("raidTeammates: falls back to the object server selection", async () => {
  const raidTeammates = await load();
  globalThis.fetch = mockFetch([TOKEN, wclRoute(ROSTERS, "object")]);
  const mates = await raidTeammates("Me", "proudmoore", "US");
  // Same result whether WCL gives server as a string or an object.
  assert.deepEqual(mates[0], { name: "Tank", server: "Proudmoore", region: "US", shared: 2 });
  assert.equal(mates.length, 3);
});

test("raidTeammates: no kills -> empty (never throws)", async () => {
  const raidTeammates = await load();
  globalThis.fetch = mockFetch([TOKEN, ["/api/v2/client", { json: { data: { characterData: {
    character: { zoneRankings: { rankings: [] } } } } } }]]);
  assert.deepEqual(await raidTeammates("Nobody", "proudmoore", "US"), []);
});
