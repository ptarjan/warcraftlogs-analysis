// Structural guarantee: across a WHOLE run, no report table/event is fetched more
// than once. Everything that reads report data goes through the central loader
// (reportCore) or a single canonical accessor, so the same (report, fight,
// dataType[, sourceID]) is never requested by two different queries. This runs the
// full analysis against a mock and fails if any logical data unit is fetched twice.
process.env.WCL_CLIENT_ID = "x";
process.env.WCL_CLIENT_SECRET = "y";
// This test verifies the AUTO-BATCHER (gql() combining concurrent misses), so it opts
// back IN to batching that test/setup.mjs turns off for the fixed-mock logic tests.
delete process.env.WCL_NO_BATCH;

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

// The VALUE WCL returns for ONE top-level field selection (`seg`), shaped by content.
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
  // Auto-batched (combined) query: top-level `_N: <field>` aliases. Slice into per-alias
  // segments and shape each -- this is what makes the request-bundling testable.
  const aliases = [...q.matchAll(/(_\d+):/g)];
  if (aliases.length) {
    const out = {};
    for (let i = 0; i < aliases.length; i++)
      out[aliases[i][1]] = shapeVal(q.slice(aliases[i].index, i + 1 < aliases.length ? aliases[i + 1].index : q.length));
    return out;
  }
  // Single query -> { <topField>: value }.
  if (/zoneRankings/.test(q) || /encounterRankings/.test(q)) return { characterData: shapeVal(q) };
  if (/characterRankings/.test(q)) return { worldData: shapeVal(q) };
  if (/reportData/.test(q)) return { reportData: shapeVal(q) };
  return {};
}

// Parse a query into the set of (code, fight, dataType[, sourceID]) units it fetches.
// Splits per report block so a BUNDLED (aliased multi-report) query attributes each
// table/event to ITS report code, not just the first -- the bundling guard.
function unitsOf(q) {
  const units = new Set();
  for (const part of q.split(/report\(\s*code:\s*"/).slice(1)) {  // each segment = CODE"){ ...this report's fields... }
    const code = (part.match(/^([^"]+)"/) || [])[1];
    if (!code) continue;
    for (const m of part.matchAll(/(?:table|events)\s*\(([^)]*)\)/g)) {
      const a = m[1];
      const fid = (a.match(/fightIDs:\s*\[?(\d+)/) || [])[1];
      const dt = (a.match(/dataType:\s*(\w+)/) || [])[1];
      const sid = (a.match(/sourceID:\s*(\d+)/) || [])[1];
      const ab = (a.match(/abilityID:\s*(\d+)/) || [])[1];
      if (fid && dt) units.add(`${code}:${fid}:${dt}${sid ? ":src" + sid : ""}${ab ? ":ab" + ab : ""}`);
    }
    // A fights(fightIDs:N) read selecting `phaseTransitions` (the boss phase boundaries,
    // for the DPS-over-time card's phase alignment) is a DISTINCT sub-resource from the
    // window read (reportCore's fightWin selects startTime/endTime). Both are fetched once
    // per fight via their one canonical path, so key them apart -- a SECOND of either is
    // still caught as a dupe. (reportCore's part never contains phaseTransitions; the graph
    // query's part always does, and carries exactly one fights read.)
    for (const m of part.matchAll(/fights\s*\(\s*fightIDs:\s*\[?(\d+)/g))
      units.add(`${code}:${m[1]}:${/phaseTransitions/.test(part) ? "phases" : "fights"}`);
    // The progression flow's report-wide fight list: fights() with NO fightIDs. One
    // canonical accessor (reportFights), so two of these on a report = a dupe.
    if (/fights\s*\{/.test(part)) units.add(`${code}:all:fights`);
  }
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

  // STRUCTURAL COST GUARD: the whole run must stay under a request ceiling. Billing is
  // complexity-scaled (so request count is NOT the points budget -- units are; see
  // wcl.js), but request COUNT still drives LATENCY and WCL's per-second throttle. gql()
  // AUTO-BATCHES concurrent fetches into one combined request, AND the cross-boss
  // sections fan out (BOSS_FANOUT), so this stays low as long as new fetches run
  // CONCURRENTLY (via mapLimit/collectUpTo/the boss fan-out). If this fails, you likely
  // added a SEQUENTIAL per-peer/per-boss fetch (awaited one at a time, so it can't
  // batch) -- issue them concurrently instead. Re-baseline the ceiling ONLY with justification.
  assert.ok(queries.length <= 55,
    `full mocked run made ${queries.length} requests (ceiling 55; fan-out + auto-batching keeps it ~43). A sequential per-peer/per-boss fetch was likely added -- run such fetches concurrently so gql() auto-batches them.`);
});

// STRUCTURAL: report-data queries may be CONSTRUCTED only in core.js, where every
// such read goes through a deduped + bundled accessor (reportCore / fightEvents /
// buffUptimes / playerAbilities / bossDebuffs / paginateEvents). An analysis module
// building its own `report(code:...)` query bypasses the loader AND the request
// bundling -- a per-peer raw query is the classic budget regression. This static
// check makes that fail CI no matter which section/archetype/code path adds it (the
// request-ceiling test only sees what the single mocked run exercises; this sees all).
test("structural: report-data queries are built ONLY in core.js (don't bypass the loader/bundlers)", async () => {
  const fs = await import("node:fs");
  const url = await import("node:url");
  const path = await import("node:path");
  const dir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "docs");
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js") || f === "core.js") continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/report\s*\(\s*code:/.test(src),
      `docs/${f} builds a raw report-data query -- route report reads through a core.js accessor ` +
      `(reportCore/fightEvents/buffUptimes/...), which are deduped + request-bundled. Don't bypass the loader.`);
  }
});

// CACHE-KEY STABILITY: the bundled prefetchers prime results under the SAME query
// string the individual accessors use, so existing cached reports (and whole cached
// characters) keep hitting. That only holds if these strings never drift -- a single
// whitespace change orphans EVERY cached report and re-fetches it, burning the budget.
// Locked byte-for-byte here (verified to reproduce 1500+ real cached keys exactly).
test("cache-key stability: report query strings are frozen (changing them orphans the cache)", async () => {
  const { _reportCoreQuery, _fightEventsQuery, _buffUptimesQuery, _characterEncounterQuery, setRunMetric } = await import("../docs/core.js");
  setRunMetric("dps");
  assert.equal(_characterEncounterQuery("AbCd", "server", "US", 5, 4),
    'query { characterData { character(\n    name:"Abcd", serverSlug:"server", serverRegion:"US") {\n    encounterRankings(encounterID:5, difficulty:4, metric:dps) } } }');
  assert.equal(_reportCoreQuery("AbCd", 3),
    'query { reportData { report(code:"AbCd") {\n    dmg: table(fightIDs:3, dataType:DamageDone)\n    casts: table(fightIDs:3, dataType:Casts)\n    combatant: events(fightIDs:3, dataType:CombatantInfo, limit:50) { data }\n    fightWin: fights(fightIDs:3) { startTime endTime } } } }');
  assert.equal(_fightEventsQuery("AbCd", 3, 7, 100, 200),
    'query { reportData { report(code:"AbCd") {\n    casts: events(fightIDs:3, sourceID:7, dataType:Casts, limit:10000, startTime: 100, endTime: 200) { data nextPageTimestamp }\n    autos: events(fightIDs:3, sourceID:7, dataType:DamageDone, abilityID:1, limit:10000, startTime: 100, endTime: 200) { data nextPageTimestamp } } } }');
  assert.equal(_buffUptimesQuery("AbCd", 3, 7),
    'query { reportData { report(code:"AbCd") {\n    table(fightIDs:3, dataType:Buffs, sourceID:7) } } }');
});

// CONCURRENT accessor calls auto-batch: 4 reportCore() in flight -> ONE request, and
// each still caches under its own key (a 2nd call is a cache hit, no fetch).
test("concurrent reportCore calls auto-batch into one request, then cache per key", async () => {
  const { clearGqlCache, _resetGqlDisk } = await import("../docs/wcl.js");
  const core = await import("../docs/core.js");
  clearGqlCache(); _resetGqlDisk();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("oauth/token")) return resp({ access_token: "t", expires_in: 3600 });
    if (u.includes("/api/v2/")) { let q = ""; try { q = JSON.parse(opts.body).query || ""; } catch {} calls.push(q); return resp({ data: shape(q) }); }
    return resp({});
  };
  const pairs = [1, 2, 3, 4].map((i) => ({ code: "BN" + i, fight: 1 }));
  const got = await Promise.all(pairs.map((p) => core.reportCore(p.code, p.fight)));   // concurrent -> batched
  assert.equal(calls.filter((c) => /reportData/.test(c)).length, 1, "4 concurrent reportCore -> ONE combined request");
  assert.ok(got.every((r) => r && r.dmg), "each caller gets its own report");
  const before = calls.length;
  for (const p of pairs) assert.ok((await core.reportCore(p.code, p.fight)).dmg, "served from cache");
  assert.equal(calls.length, before, "second pass hits the cache -- no extra fetch");
});
