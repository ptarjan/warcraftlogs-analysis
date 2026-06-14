// Raid PROGRESSION analyzer: pull-by-pull blocker detection. Mocked WCL GraphQL +
// Wowhead, no network. Covers wall detection, named survival callouts, the
// recurrence gate, kill short-circuit, the DPS check, finding ordering, and that a
// whole-night analysis stays within a small request budget.
process.env.WCL_CLIENT_ID = "x";
process.env.WCL_CLIENT_SECRET = "y";

import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const prog = await import("../docs/progression.js");
const { clearGqlCache } = await import("../docs/wcl.js");

// --- fixtures: one boss (encounter 100, Mythic), 14 pulls, walling at ~20% ----- //
const FP = { 1: 60, 2: 60, 3: 45, 4: 45, 5: 30, 6: 30, 7: 30, 8: 30, 9: 20, 10: 20, 11: 10, 12: 20, 13: 20, 14: 20 };
const fightsFixture = () => Array.from({ length: 14 }, (_, i) => {
  const id = i + 1;
  return {
    id, name: "Test Boss", encounterID: 100, kill: false, difficulty: 5, size: 20,
    startTime: id * 1000, endTime: id * 1000 + 300000,
    fightPercentage: FP[id], bossPercentage: FP[id],
    lastPhase: id >= 5 ? 2 : 1, averageItemLevel: 639,
    friendlyPlayers: id === 11 || id === 14 ? [20, 21, 22, 23, 24, 25] : [20, 21, 22, 23, 24],
  };
});

// Deaths: ability 500 ("Doom") kills Bob in pulls 5-14 (10 pulls); 501 kills Sue in
// 5-12 (8); a one-off ability 999 kills Carl in pull 3 ONLY (recurrence gate).
function deathsFixture() {
  const out = [];
  const end = (fid) => fid * 1000 + 300000;
  for (let fid = 5; fid <= 14; fid++) out.push({ fight: fid, timestamp: end(fid) - 5000, targetID: 20, killingAbilityGameID: 500 });
  for (let fid = 5; fid <= 12; fid++) out.push({ fight: fid, timestamp: end(fid) - 4000, targetID: 21, killingAbilityGameID: 501 });
  out.push({ fight: 3, timestamp: end(3) - 3000, targetID: 22, killingAbilityGameID: 999 });
  return out;
}

const ROSTER = [
  { id: 20, name: "Bob", type: "Player", subType: "Monk" },
  { id: 21, name: "Sue", type: "Player", subType: "Priest" },
  { id: 22, name: "Carl", type: "Player", subType: "Mage" },
  { id: 23, name: "Dot", type: "Player", subType: "Druid" },
  { id: 24, name: "Eve", type: "Player", subType: "Rogue" },
  { id: 25, name: "NewGuy", type: "Player", subType: "Warrior" },
];

// DamageDone table for the DPS check: 5 players, one clear laggard (LowDps).
const coreData = () => ({ reportData: { report: {
  dmg: { data: { totalTime: 300000, entries: [
    { name: "Bob", type: "Monk", total: 400e6 }, { name: "Sue", type: "Priest", total: 380e6 },
    { name: "Carl", type: "Mage", total: 360e6 }, { name: "Dot", type: "Druid", total: 350e6 },
    { name: "LowDps", type: "Warrior", total: 100e6 },
  ] } },
  casts: { data: { totalTime: 300000, entries: [] } },
  combatant: { data: [] }, fightWin: [{ startTime: 0, endTime: 300000 }],
} } });

const resp = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o, text: async () => JSON.stringify(o) });

function shape(q) {
  if (/dmg:\s*table/.test(q)) return coreData();
  if (/dataType:\s*Deaths/.test(q)) return { reportData: { report: { events: { data: deathsFixture(), nextPageTimestamp: null } } } };
  if (/masterData/.test(q)) return { reportData: { report: { masterData: { actors: ROSTER } } } };
  if (/characterRankings/.test(q)) return { worldData: { encounter: { characterRankings: { rankings: [
    { duration: 240000 }, { duration: 250000 }, { duration: 230000 },
  ] } } } };
  if (/fights\s*\{/.test(q)) return { reportData: { report: { fights: fightsFixture() } } };
  return {};
}

function install() {
  clearGqlCache();
  const queries = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("oauth/token")) return resp({ access_token: "t", expires_in: 3600 });
    if (u.includes("wowhead.com")) { const id = (u.match(/spell\/(\d+)/) || [])[1]; return resp({ name: id === "500" ? "Doom" : id === "501" ? "Cleave" : "spell" }); }
    if (u.includes("/api/v2/")) { let q = ""; try { q = JSON.parse(opts.body).query || ""; } catch {} queries.push(q); return resp({ data: shape(q) }); }
    throw new Error("no mock route for " + u);
  };
  return queries;
}

test("pickEncounter: with no boss named, picks the most-pulled encounter", () => {
  const fights = [
    { encounterID: 1, name: "A", kill: false }, { encounterID: 1, name: "A", kill: false },
    { encounterID: 2, name: "B", kill: false }, { encounterID: 0, name: "trash", kill: false },
  ];
  const e = prog.pickEncounter(fights);
  assert.equal(e.encounterID, 1);
  assert.equal(e.pulls.length, 2);
});

test("pickEncounter: honors an explicit encounter id", () => {
  const fights = [{ encounterID: 1, name: "A" }, { encounterID: 2, name: "B" }, { encounterID: 2, name: "B" }];
  assert.equal(prog.pickEncounter(fights, 2).pulls.length, 2);
});

test("encountersIn: tallies pulls and kills per encounter, most-pulled first", () => {
  const fights = [
    { encounterID: 5, name: "X", kill: false }, { encounterID: 5, name: "X", kill: true },
    { encounterID: 6, name: "Y", kill: false },
  ];
  const list = prog.encountersIn(fights);
  assert.equal(list[0].encounterID, 5);
  assert.equal(list[0].pulls, 2);
  assert.equal(list[0].kills, 1);
});

test("progressionFindings: detects the wall, names the lethal mechanic + repeat deaths", async () => {
  install();
  const r = await prog.progressionFindings("ABC123DEF4");
  assert.equal(r.boss, "Test Boss");
  assert.equal(r.killed, false);
  assert.equal(r.multiPhase, true);
  // Modal recent-wipe bucket is ~20% in phase 2.
  assert.equal(r.wall.rem, 20);
  assert.equal(r.wall.phase, 2);
  assert.equal(r.bestRemaining, 10); // deepest pull

  const texts = r.findings.map((f) => f.text).join("\n");
  assert.match(texts, /Doom/, "names the recurring killing-blow ability");
  assert.match(texts, /Bob/, "names a repeat-dying player");
  assert.doesNotMatch(texts, /spell 999|999/, "a one-off death (1 pull) is below the recurrence gate");
});

test("progressionFindings: surfaces a DPS check when the raid is damage-light and not death-capped", async () => {
  install();
  const r = await prog.progressionFindings("ABC123DEF4");
  assert.ok(r.dps && r.dps.deficit > 5, "a real DPS deficit is computed from boss-HP est vs field kill time");
  const dpsFinding = r.findings.find((f) => f.dim === "DPSCheck");
  assert.ok(dpsFinding, "a DPSCheck finding is present");
  assert.match(dpsFinding.text, /LowDps/, "names the lowest contributor");
});

test("progressionFindings: findings are sorted biggest-blocker-first and capped", async () => {
  install();
  const r = await prog.progressionFindings("ABC123DEF4");
  assert.ok(r.findings.length <= 5);
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(r.findings[i - 1].impact >= r.findings[i].impact, "non-increasing impact");
  }
});

test("progressionFindings: a killed boss short-circuits to 'down', no blocker invented", async () => {
  clearGqlCache();
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("oauth/token")) return resp({ access_token: "t", expires_in: 3600 });
    if (u.includes("/api/v2/")) {
      const q = JSON.parse(opts.body).query || "";
      if (/fights\s*\{/.test(q)) {
        const fights = fightsFixture();
        fights[13].kill = true; fights[13].fightPercentage = 0; // last pull is a kill
        return resp({ data: { reportData: { report: { fights } } } });
      }
      return resp({ data: shape(q) });
    }
    throw new Error("no route " + u);
  };
  const r = await prog.progressionFindings("ABC123DEF4");
  assert.equal(r.killed, true);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].dim, "Info");
  assert.match(r.findings[0].text, /down/i);
});

test("progressionFindings: a whole night stays within a small request budget", async () => {
  const queries = install();
  await prog.progressionFindings("ABC123DEF4");
  // 1 fights + 1 deaths + 1 masterData + 2 reportCore (deepest+recent) + 1 killTimes.
  assert.ok(queries.length <= 7, `expected <=7 GraphQL requests for a 14-pull night, got ${queries.length}`);
});
