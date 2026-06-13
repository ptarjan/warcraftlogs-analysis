// Structural guarantee: across a WHOLE run, no report table/event is fetched more
// than once. Everything that reads report data goes through the central loader
// (reportCore) or a single canonical accessor, so the same (report, fight,
// dataType[, sourceID]) is never requested by two different queries. This runs the
// full analysis against a mock and fails if any logical data unit is fetched twice.
process.env.WCL_CLIENT_ID = "x";
process.env.WCL_CLIENT_SECRET = "y";

import test from "node:test";
import assert from "node:assert/strict";

const IL = 480, NAME = "Hadryan", CLS = "Monk", SPEC = "Brewmaster";
const ent = (n) => Array.from({ length: n }, (_, i) => ({
  name: i === 0 ? NAME : "Peer" + i, id: i + 1, type: CLS, itemLevel: IL, icon: `${CLS}-${SPEC}`,
  total: 2e7 - i * 1e4, activeTime: 19e4, targets: [1], abilities: [{ name: "TP", total: 100, type: 1 }],
  gear: [{ slot: 0, id: 1, itemLevel: IL, permanentEnchant: 1, permanentEnchantName: "E", bonusIDs: [], gems: [] }] }));
const tbl = () => ({ totalTime: 2e5, entries: ent(6), auras: [{ name: "Flask", totalUptime: 19e4, guid: 1 }] });
const comb = () => Array.from({ length: 6 }, (_, i) => ({ sourceID: i + 1, critMelee: 1, hasteMelee: 1, mastery: 1, versatilityDamageDone: 1, agility: 1, stamina: 1 }));
const evs = () => Array.from({ length: 200 }, (_, i) => ({ timestamp: i * 800, type: "cast", abilityGameID: 1, sourceID: 1 }));
const resp = (o) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => o, text: async () => JSON.stringify(o) });

function shape(q) {
  if (/zoneRankings/.test(q)) return { characterData: { character: { id: 1, classID: 1, zoneRankings: {
    zone: 1, bestPerformanceAverage: 60, medianPerformanceAverage: 55,
    rankings: Array.from({ length: 8 }, (_, i) => ({ encounter: { id: i + 1, name: "B" + i }, totalKills: 8, rankPercent: 60, bracketData: IL })) } } } };
  if (/characterRankings/.test(q)) return { worldData: { encounter: { characterRankings: { rankings: Array.from({ length: 100 }, (_, i) => ({
    name: "Peer" + i, class: CLS, spec: SPEC, amount: 2e7 - i, bracketData: IL - 2 + (i % 5),
    server: { name: "S", region: "US" }, report: { code: "PR" + (i % 20), fightID: (i % 5) + 1 }, duration: 2e5, startTime: i })) } } } };
  if (/encounterRankings/.test(q)) { const eid = (q.match(/encounterID:\s*(\d+)/) || [])[1] || "0";
    return { characterData: { character: { encounterRankings: { ranks: Array.from({ length: 8 }, (_, k) => ({
      bracketData: IL, rankPercent: 60, startTime: k, report: { code: `RK${eid}_${k}`, fightID: k + 1 }, duration: 2e5 })) } } } }; }
  if (/reportData/.test(q)) { // universal report -- shape each field per the query
    return { reportData: { report: {
      dmg: { data: tbl() },
      casts: /casts:\s*events/.test(q) ? { data: evs(), nextPageTimestamp: null } : { data: tbl() },
      combatant: { data: comb() }, fightWin: [{ startTime: 0, endTime: 2e5 }],
      autos: { data: evs(), nextPageTimestamp: null }, fights: [{ startTime: 0, endTime: 2e5 }], table: { data: tbl() },
      events: { data: /CombatantInfo/.test(q) ? comb() : evs(), nextPageTimestamp: null } } } };
  }
  return {};
}

// Parse a query into the set of (code, fight, dataType[, sourceID]) units it fetches.
function unitsOf(q) {
  const code = (q.match(/report\(\s*code:\s*"([^"]+)"/) || [])[1];
  const units = new Set();
  if (!code) return units;
  for (const m of q.matchAll(/(?:table|events)\s*\(([^)]*)\)/g)) {
    const a = m[1];
    const fid = (a.match(/fightIDs:\s*\[?(\d+)/) || [])[1];
    const dt = (a.match(/dataType:\s*(\w+)/) || [])[1];
    const sid = (a.match(/sourceID:\s*(\d+)/) || [])[1];
    const ab = (a.match(/abilityID:\s*(\d+)/) || [])[1];
    if (fid && dt) units.add(`${code}:${fid}:${dt}${sid ? ":src" + sid : ""}${ab ? ":ab" + ab : ""}`);
  }
  for (const m of q.matchAll(/fights\s*\(\s*fightIDs:\s*\[?(\d+)/g)) units.add(`${code}:${m[1]}:fights`);
  return units;
}

test("each report table/event is fetched at most once across a full run", async () => {
  const queries = [];
  globalThis.localStorage = (() => { const s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; })();
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("oauth/token")) return resp({ access_token: "t", expires_in: 3600 });
    if (u.includes("/api/v2/")) { let q = ""; try { q = JSON.parse(opts.body).query || ""; } catch {} queries.push(q); return resp({ data: shape(q) }); }
    return resp({ name: "I", quality: 3, tooltip: "", itemLevel: IL });
  };

  const core = await import("../docs/core.js");
  const overview = await import("../docs/overview.js");
  const timeline = await import("../docs/timeline.js");
  const rotation = await import("../docs/rotation.js");
  const topparse = await import("../docs/topparse.js");
  const gear = await import("../docs/gear.js");
  const prescribe = await import("../docs/prescribe.js");
  const log = () => {};

  const ctx = await core.detectContext(NAME, "s", "US");
  const pr = await core.detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
  const p = { name: NAME, server: "s", region: "US", cls: ctx.className, spec: ctx.specName, difficulty: ctx.difficulty, priority: pr };
  // Mirror the app's run order so the test exercises the same fetch sequence.
  await overview.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty);
  await timeline.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty);
  await rotation.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty);
  await topparse.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty);
  await gear.run(log, p.name, p.server, p.region, p.difficulty, p.cls, p.spec, p.priority);
  await prescribe.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty, p.priority);

  const cover = new Map();
  for (const q of queries) for (const u of unitsOf(q)) cover.set(u, (cover.get(u) || 0) + 1);
  const dupes = [...cover.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]);
  assert.deepEqual(dupes, [], `these report tables were fetched more than once in a single run:\n${dupes.map(([u, c]) => `  ${u} x${c}`).join("\n")}`);
});
