// End-to-end test of prescribe.run() against a mocked WCL: the integration path the
// unit tests don't cover. loader.test.mjs runs the full pipeline but only asserts fetch
// DEDUP; this asserts the OUTPUT -- run() completes, emits a real prescription, and
// never an [error] line. (run() THROWS on an unhandled error, and the synthesis path
// catches per-section failures into a `skipped` note + an [error] line, so both failure
// modes are caught here.) The query shaper is the same content-keyed mock loader.test
// uses; WCL_NO_BATCH (test/setup.mjs default) keeps queries individual, not aliased.
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

function shapeVal(seg) {
  if (/zoneRankings/.test(seg)) return { character: { id: 1, classID: 1, zoneRankings: {
    zone: 1, bestPerformanceAverage: 60, medianPerformanceAverage: 55,
    rankings: Array.from({ length: 8 }, (_, i) => ({ encounter: { id: i + 1, name: "B" + i }, totalKills: 8, rankPercent: 60, bracketData: IL })) } } };
  if (/characterRankings/.test(seg)) return { encounter: { characterRankings: { rankings: Array.from({ length: 100 }, (_, i) => ({
    name: "Peer" + i, class: CLS, spec: SPEC, amount: 2e7 - i, bracketData: IL - 2 + (i % 5),
    server: { name: "S", region: "US" }, report: { code: "PR" + (i % 20), fightID: (i % 5) + 1 }, duration: 2e5, startTime: i })) } } };
  if (/encounterRankings/.test(seg)) { const eid = (seg.match(/encounterID:\s*(\d+)/) || [])[1] || "0";
    return { character: { encounterRankings: { ranks: Array.from({ length: 8 }, (_, k) => ({
      bracketData: IL, rankPercent: 60, startTime: k, report: { code: `RK${eid}_${k}`, fightID: k + 1 }, duration: 2e5 })) } } }; }
  if (/report\s*\(\s*code:/.test(seg) || /reportData/.test(seg)) return { report: {
    dmg: { data: tbl() },
    casts: /casts:\s*events/.test(seg) ? { data: evs(), nextPageTimestamp: null } : { data: tbl() },
    combatant: { data: comb() }, fightWin: [{ startTime: 0, endTime: 2e5 }],
    autos: { data: evs(), nextPageTimestamp: null }, fights: [{ startTime: 0, endTime: 2e5 }], table: { data: tbl() },
    events: { data: /CombatantInfo/.test(seg) ? comb() : evs(), nextPageTimestamp: null } } };
  return {};
}
function shape(q) {
  if (/zoneRankings/.test(q) || /encounterRankings/.test(q)) return { characterData: shapeVal(q) };
  if (/characterRankings/.test(q)) return { worldData: shapeVal(q) };
  if (/reportData/.test(q)) return { reportData: shapeVal(q) };
  return {};
}

function installMock() {
  globalThis.localStorage = (() => { const s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; })();
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("oauth/token")) return resp({ access_token: "t", expires_in: 3600 });
    if (u.includes("/api/v2/")) { let q = ""; try { q = JSON.parse(opts.body).query || ""; } catch { /* ignore */ } return resp({ data: shape(q) }); }
    // Wowhead tooltips + Raidbots talents.json: a harmless fallback (talents then
    // skips gracefully -- talent rendering is covered by levers.test.mjs).
    return resp({ name: "I", quality: 3, tooltip: "", itemLevel: IL });
  };
}

// Run prescribe.run() the way the app/CLI does for an archetype (the caller sets the
// metric/support flag from the spec), capture the lines, and assert the universal
// invariants: a real prescription, never a crash/[error]. metricRx checks the unit
// switched (DPS vs HPS) -- the healer/support paths have their own residual prose.
async function runArchetype(core, prescribe, { cls, spec, metric, support }) {
  installMock();
  core.setRunMetric(metric);
  core.setRunSupport(!!support);
  try {
    const lines = [];
    const pr = await core.detectPriority(cls, spec, 5, 1);
    await prescribe.run((s = "") => lines.push(s), NAME, "s", "US", cls, spec, 5, pr);
    return lines;
  } finally { core.setRunMetric("dps"); core.setRunSupport(false); }
}

const ARCHETYPES = [
  { name: "DPS", cls: "Monk", spec: "Brewmaster", metric: "dps", unit: /% DPS/ },
  { name: "healer", cls: "Druid", spec: "Restoration", metric: "hps", unit: /% HPS|HEALING/ },
  { name: "support", cls: "Evoker", spec: "Augmentation", metric: "dps", support: true, unit: /% DPS/ },
];

for (const a of ARCHETYPES) {
  test(`prescribe.run emits a complete prescription (no error) -- ${a.name}`, async () => {
    const core = await import("../docs/core.js");
    const prescribe = await import("../docs/prescribe.js");
    const lines = await runArchetype(core, prescribe, a);
    const out = lines.join("\n");
    // (The "# PRESCRIPTION" banner is CLI/section chrome; run()'s own output opens with
    // the percentile line.)
    assert.match(out, /You parse \d+th percentile/, "emits the percentile line");
    assert.match(out, a.unit, `output uses the ${a.name} metric unit`);
    // Fail-soft means a partial list, never a crash -- no [error] line.
    assert.ok(!lines.some((l) => /^\[error\]/.test(l)), `no [error] line; got:\n${lines.filter((l) => /error/i.test(l)).join("\n")}`);
  });
}
