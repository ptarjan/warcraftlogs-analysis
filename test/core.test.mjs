// "Current gear/consumables" kill selection: top item level, but the MOST RECENT
// kill at that level -- so recent enchant/gem/consumable fixes aren't hidden by an
// old high-ilvl kill. bestRank is pure (no network).
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage, mockFetch } from "./helpers.mjs";

process.env.WCL_CLIENT_ID = "x";
process.env.WCL_CLIENT_SECRET = "y";
installLocalStorage();
const { bestRank, isHealer, metricForSpec, setRunMetric, runMetric, metricUnit, runIsHealer, eventTable, DPS, collectUpTo, detectContext, isAtonement, alwaysAtonement, atonementIfDamaging, FISTWEAVE_DAMAGE_SHARE, ordinal, collectPeers, kfmt, head, subhead, arrow, flag } = await import("../docs/core.js");
const { clearGqlCache } = await import("../docs/wcl.js");

test("ordinal: correct English suffix (no more '62th'/'91th' percentile)", () => {
  // The bug this guards: prescribe printed `${p}th` blindly -> "62th percentile".
  assert.equal(ordinal(1), "1st");
  assert.equal(ordinal(2), "2nd");
  assert.equal(ordinal(3), "3rd");
  assert.equal(ordinal(4), "4th");
  assert.equal(ordinal(22), "22nd");
  assert.equal(ordinal(33), "33rd");
  assert.equal(ordinal(62), "62nd");
  assert.equal(ordinal(91), "91st");
  assert.equal(ordinal(92), "92nd");
  assert.equal(ordinal(100), "100th");
  // 11/12/13 are the irregular ones that stay "th".
  assert.equal(ordinal(11), "11th");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(13), "13th");
  assert.equal(ordinal(111), "111th");
  assert.equal(ordinal(13.4), "13th", "rounds before suffixing");
});

test("collectUpTo: stops once n succeed; only fetches the buffer to backfill failures", async () => {
  // 13 candidates, all succeed -> reach n=10 in two waves of 5; the 3-candidate
  // buffer (10,11,12) is never fetched.
  const ids = Array.from({ length: 13 }, (_, i) => i);
  const fetched = [];
  const all = await collectUpTo(ids, 10, 5, async (i) => { fetched.push(i); return `v${i}`; });
  assert.deepEqual(all, Array.from({ length: 10 }, (_, i) => `v${i}`));
  assert.ok(![10, 11, 12].some((i) => fetched.includes(i)), "buffer not fetched when the first 10 succeed");
  // With 2 failures, the buffer IS fetched to backfill back up to 10, order preserved.
  const f2 = [];
  const r2 = await collectUpTo(ids, 10, 5, async (i) => { f2.push(i); return (i === 2 || i === 7) ? null : `v${i}`; });
  assert.equal(r2.length, 10, "backfilled to 10 despite 2 failures");
  assert.ok(r2.every(Boolean) && !r2.includes("v2") && !r2.includes("v7"), "failures excluded");
  assert.ok(f2.includes(10) && f2.includes(11), "buffer fetched to backfill");
});

test("isHealer flags every healing spec, by spec name across classes", () => {
  for (const s of ["Holy", "Discipline", "Restoration", "Mistweaver", "Preservation"])
    assert.equal(isHealer(s), true, `${s} is a healer`);
  // DPS/tank specs are not healers (incl. specs that share a class with a healer)
  for (const s of ["Shadow", "Retribution", "Balance", "Frost", "Brewmaster", "Guardian", "Protection", "Devastation"])
    assert.equal(isHealer(s), false, `${s} is not a healer`);
});

test("isAtonement: Discipline always heals through damage; Mistweaver only when fistweaving", () => {
  // Discipline (Atonement) -- ALL its healing is damage-driven, so always atonement,
  // regardless of damage share.
  assert.equal(alwaysAtonement("Discipline"), true);
  assert.equal(isAtonement("Discipline", 0), true);
  assert.equal(isAtonement("Discipline", 0.5), true);
  // Mistweaver -- atonement ONLY when actually dealing damage (fistweaving). A pure
  // caster Mistweaver (trivial damage) must NOT be told to press a damage rotation.
  assert.equal(atonementIfDamaging("Mistweaver"), true);
  assert.equal(isAtonement("Mistweaver", FISTWEAVE_DAMAGE_SHARE + 0.05), true, "fistweaving -> atonement");
  assert.equal(isAtonement("Mistweaver", 0.05), false, "barely any damage -> not fistweaving");
  // Pure healers and non-healers never qualify (their damage isn't a healing lever).
  for (const s of ["Holy", "Restoration", "Preservation", "Shadow", "Frost", "Brewmaster"])
    assert.equal(isAtonement(s, 0.9), false, `${s} is not atonement-style`);
});

test("metricForSpec: healer specs -> hps, everyone else -> dps", () => {
  for (const s of ["Holy", "Discipline", "Restoration", "Mistweaver", "Preservation"])
    assert.equal(metricForSpec("X", s), "hps", `${s} should be hps`);
  for (const s of ["Brewmaster", "Assassination", "Frost", "Protection", "Arms", "Balance"])
    assert.equal(metricForSpec("X", s), "dps", `${s} should be dps`);
});

test("setRunMetric flips the unit, event table, and the DPS() label; defaults to dps", () => {
  assert.equal(runMetric(), "dps");                 // default leaves the damage path untouched
  assert.equal(DPS(3).label, "~3% DPS");
  assert.equal(eventTable(), "DamageDone");
  try {
    setRunMetric("hps");
    assert.equal(metricUnit(), "HPS");
    assert.equal(runIsHealer(), true);
    assert.equal(eventTable(), "Healing");          // WCL healing table is "Healing", not "HealingDone"
    assert.equal(DPS(3).label, "~3% HPS");          // same impact, healing unit
    assert.equal(DPS(1, 3).label, "~1-3% HPS");
  } finally {
    setRunMetric("dps");                            // never leak the global to other tests
  }
  assert.equal(eventTable(), "DamageDone");
});

const r = (ilvl, t, id) => ({ bracketData: ilvl, startTime: t, _id: id });

test("bestRank picks the most recent kill among those at your top item level", () => {
  const picked = bestRank([r(279, 100, "old"), r(279, 500, "new"), r(279, 300, "mid")]);
  assert.equal(picked._id, "new");
});

test("bestRank prefers a recent current-ilvl kill over a stale higher one (within band)", () => {
  // The classic case: a lucky 280 drop two weeks ago vs tonight's 279 kills.
  const picked = bestRank([r(280, 100, "lucky-old"), r(279, 900, "tonight")]);
  assert.equal(picked._id, "tonight", "1 ilvl lower but far more recent -> current state");
});

test("bestRank ignores a recent kill from much lower gear (outside the band)", () => {
  const picked = bestRank([r(279, 100, "current"), r(270, 900, "alt-gear")]);
  assert.equal(picked._id, "current", "9 ilvls lower is not 'current gear', even if recent");
});

test("bestRank returns null for no ranks", () => {
  assert.equal(bestRank([]), null);
  assert.equal(bestRank(null), null);
});

// STRUCTURAL INVARIANT (the whole class of bug, not two files): an analysis
// module must NEVER build its own peer/field selection (collectPeers) or raw
// query (gql). Those live ONCE in core, behind named selectors (ilvlPeers for the
// ilvl-matched field, topField for the top-DPS field) and fetchers. Two modules
// that build the "same" selection inline drift apart (different ilvl/window/pages)
// and stop deduping -- a pile of redundant fetches. Forcing everything through
// the named core functions makes that impossible: same need -> same function ->
// fetches coalesce. This test fails CI the moment a module reaches for the raw
// primitives, so a future analysis can't reintroduce the divergence.
test("analysis modules select peers/field + fetch ONLY via named core functions", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("../docs/", import.meta.url));
  const DATA_LAYER = new Set(["core.js", "wcl.js"]); // these own the primitives
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && !DATA_LAYER.has(f))) {
    const src = readFileSync(dir + file, "utf8")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n"); // ignore comments
    assert.doesNotMatch(src, /\bcollectPeers\s*\(/, `${file}: select peers via core.ilvlPeers/topField, never collectPeers`);
    assert.doesNotMatch(src, /\bgql\s*\(/, `${file}: fetch via named core functions, never raw gql`);
  }
});

// The unfiltered reportCore DamageDone table truncates to ~5 abilities/actor, which
// for a caster drops the core casts (a Frost Mage's Frostbolt/Ice Lance/Glacial
// Spike) and makes the cast rate undercount APM ~5x (read "9 casts/min" vs ~50).
// rotation MUST read its ability list from the per-player sourceID-filtered table
// (core.playerAbilities), never the truncated unfiltered one. Locks the fix.
test("rotation builds its ability list from the sourceID-filtered table, not the truncated one", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("../docs/rotation.js", import.meta.url)), "utf8");
  assert.match(src, /playerAbilities\s*\(/, "rotation must use core.playerAbilities (full, sourceID-filtered list)");
  assert.doesNotMatch(src, /reportCore\([^)]*\)\s*\)\s*\.dmg\.data\.entries/, "must not read the truncated unfiltered dmg entries for abilities");
});

// A spec-flexer must be detected on the spec they ACTUALLY PLAYED on the kill the
// analysis uses (bestKill = the most-recent current-gear kill), not on an older,
// higher-parsing spec. The bug: an Unholy DK whose most-recent kill is Unholy was
// detected as Frost off a stale 90th-pct parse, then the rotation compared his Unholy
// casts to FROST peers and told him to "press Obliterate" -- an ability Unholy lacks.
test("detectContext: a spec-flexer is detected on the most-recent kill's spec, not an older parse", async () => {
  const NAME = "Flexer";
  process.env.WCL_ALLOW_FETCH = "1";   // permit the mock fetch (cache misses would otherwise throw)
  // enc 1 = an OLD Frost kill that parsed 90th; enc 2 = a MORE-RECENT Unholy kill that
  // parsed 50th. Same ilvl, so bestKill picks the most recent (enc 2 / Unholy).
  globalThis.fetch = mockFetch([
    ["oauth/token", { json: { access_token: "t", expires_in: 3600 } }],
    ["/api/v2/", (u, opts) => {
      const q = JSON.parse(opts.body).query || "";
      if (/zoneRankings/.test(q)) return { json: { data: { characterData: { character: { id: 1, classID: 6, zoneRankings: {
        zone: 1, bestPerformanceAverage: 70, medianPerformanceAverage: 50, rankings: [
          { encounter: { id: 1, name: "B1" }, totalKills: 1, rankPercent: 90, bracketData: 480 },
          { encounter: { id: 2, name: "B2" }, totalKills: 1, rankPercent: 50, bracketData: 480 },
        ] } } } } } };
      if (/encounterRankings/.test(q)) {
        const eid = (q.match(/encounterID:\s*(\d+)/) || [])[1];
        const ranks = eid === "2"
          ? [{ bracketData: 480, rankPercent: 50, startTime: 100, report: { code: "UNHOLY2", fightID: 1 }, duration: 2e5 }]
          : [{ bracketData: 480, rankPercent: 90, startTime: 1, report: { code: "FROST1", fightID: 1 }, duration: 2e5 }];
        return { json: { data: { characterData: { character: { encounterRankings: { ranks } } } } } };
      }
      if (/reportData/.test(q)) {
        const code = (q.match(/report\(\s*code:\s*"([^"]+)"/) || [])[1] || "";
        const spec = code.includes("UNHOLY") ? "Unholy" : "Frost";
        const report = { dmg: { data: { totalTime: 2e5, entries: [
          { name: NAME, id: 1, type: "DeathKnight", icon: `DeathKnight-${spec}`, itemLevel: 480, total: 1e7 },
        ], auras: [] } } };
        return { json: { data: { reportData: { report } } } };
      }
      return { json: { data: {} } };
    }],
  ]);
  const ctx = await detectContext(NAME, "s", "US");
  assert.equal(ctx.className, "DeathKnight");
  assert.equal(ctx.specName, "Unholy", "detected the most-recent kill's spec (Unholy), not the older Frost parse");
});

test("detectContext resets a leaked run-metric so a DPS detects after a healer (no hps-ranking starvation)", async () => {
  // The browser analyzes character after character without a reload, and detection runs
  // BEFORE setRunContext. Analyze a healer (metric -> hps), then a DPS: detection would
  // query the DPS's HEALING ranks (empty) and fail with "couldn't determine class". The
  // fix resets the metric to the neutral default at the start of detectContext.
  const NAME = "Dpser";
  process.env.WCL_ALLOW_FETCH = "1";
  setRunMetric("hps"); // simulate the prior healer run's leaked global
  globalThis.fetch = mockFetch([
    ["oauth/token", { json: { access_token: "t", expires_in: 3600 } }],
    ["/api/v2/", (u, opts) => {
      const q = JSON.parse(opts.body).query || "";
      if (/zoneRankings/.test(q)) return { json: { data: { characterData: { character: { id: 1, classID: 6, zoneRankings: {
        zone: 1, bestPerformanceAverage: 70, medianPerformanceAverage: 50, rankings: [
          { encounter: { id: 1, name: "B1" }, totalKills: 1, rankPercent: 80, bracketData: 480 },
        ] } } } } } };
      if (/encounterRankings/.test(q)) {
        // A pure DPS has NO healing ranks: empty under hps, real under dps. Without the reset
        // detection queries hps here, gets [], and throws; with it, dps finds the kill.
        const ranks = /metric:\s*hps/.test(q) ? []
          : [{ bracketData: 480, rankPercent: 80, startTime: 100, report: { code: "RPT1", fightID: 1 }, duration: 2e5 }];
        return { json: { data: { characterData: { character: { encounterRankings: { ranks } } } } } };
      }
      if (/reportData/.test(q)) return { json: { data: { reportData: { report: { dmg: { data: { totalTime: 2e5, entries: [
        { name: NAME, id: 1, type: "DeathKnight", icon: "DeathKnight-Frost", itemLevel: 480, total: 1e7 },
      ], auras: [] } } } } } } };
      return { json: { data: {} } };
    }],
  ]);
  try {
    const ctx = await detectContext(NAME, "s", "US");
    assert.equal(ctx.className, "DeathKnight", "detected despite the leaked hps metric");
    assert.equal(runMetric(), "dps", "detection reset the leaked metric to the neutral default");
  } finally { setRunMetric("dps"); }
});

// Kill SELECTION must also be spec-consistent: a flexer's off-spec kills must not seed
// the benchmark/measurement kill. The bug (one layer past detection): an Unholy DK's
// median-parse kill was a FROST one, so prescribe measured 0% pet damage and 0 Scourge
// Strike against UNHOLY peers (Frost has no ghoul / presses Obliterate). bestRank with a
// specName filters to that spec using each rank's `spec` field.
test("bestRank: specName restricts to that spec's kills; graceful when spec data is absent", () => {
  const ranks = [
    { spec: "Frost",  bracketData: 290, startTime: 500, report: { code: "F2", fightID: 1 }, rankPercent: 95 }, // most recent overall, Frost
    { spec: "Unholy", bracketData: 290, startTime: 400, report: { code: "U1", fightID: 1 }, rankPercent: 60 },
    { spec: "Frost",  bracketData: 290, startTime: 100, report: { code: "F1", fightID: 1 }, rankPercent: 90 },
  ];
  assert.equal(bestRank(ranks).report.code, "F2", "unfiltered = most-recent overall (Frost)");
  assert.equal(bestRank(ranks, "Unholy").report.code, "U1", "Unholy filter skips the more-recent Frost kills");
  const noSpec = ranks.map(({ spec, ...r }) => r);
  assert.equal(bestRank(noSpec, "Unholy").report.code, "F2", "no spec data -> unfiltered (graceful)");
});

test("collectPeers: an out-of-band ranking on one boss doesn't block the same player's in-band ranking on another", async () => {
  // The bug: a player was added to the dedupe `seen` set BEFORE the ilvl-band filter, so an
  // out-of-band kill on encounter 1 marked them seen and skipped their in-band kill on
  // encounter 2 -- thinning the peer sample. Fix: filter by ilvl, THEN dedupe.
  process.env.WCL_ALLOW_FETCH = "1";
  clearGqlCache();
  globalThis.fetch = mockFetch([
    ["oauth/token", { json: { access_token: "t", expires_in: 3600 } }],
    ["/api/v2/", (u, opts) => {
      const q = JSON.parse(opts.body).query || "";
      const eid = (q.match(/encounter\(id:(\d+)\)/) || [])[1];
      // "Dup" is OUT of band on enc 1 (ilvl 500 vs target 480) but IN band on enc 2 (481).
      // "InbandOnly" is in band on enc 1 (sanity: a normal in-band peer is collected).
      const rankings = eid === "1"
        ? [{ name: "Dup", server: { name: "S" }, bracketData: 500 },
           { name: "InbandOnly", server: { name: "S" }, bracketData: 480 }]
        : [{ name: "Dup", server: { name: "S" }, bracketData: 481 }];
      return { json: { data: { worldData: { encounter: { characterRankings: { rankings } } } } } };
    }],
  ]);
  const peers = await collectPeers({
    encounters: [1, 2], difficulty: 5, className: "Monk", specName: "Brewmaster",
    limit: 10, pages: 1, ilvl: 480, window: 3, dedupe: true,
  });
  const names = peers.map((p) => p.name);
  assert.ok(names.includes("Dup"), "in-band kill on enc 2 is collected despite the out-of-band enc-1 kill");
  assert.ok(names.includes("InbandOnly"), "the normal in-band peer is collected");
  assert.equal(names.filter((n) => n === "Dup").length, 1, "deduped to one entry, not duplicated");
});

// --- shared readout grammar (format.js) ----------------------------------------
test("readout grammar: kfmt/head/subhead/arrow are the ONE definition of the panel format", () => {
  // kfmt: identical k/M throughput on every card (overview used raw "27,999 dps").
  assert.equal(kfmt(27999), "28k");
  assert.equal(kfmt(66700), "67k");
  assert.equal(kfmt(1_240_000), "1.2M");
  assert.equal(kfmt(840), "840");
  assert.equal(kfmt(0), "0");
  assert.equal(kfmt(-5200), "-5k");
  // The grammar tokens the app renderer keys off (=== head ===, --- sub ---, -> takeaway).
  assert.equal(head("OPENER"), "=== OPENER ===");
  assert.equal(subhead("by boss"), "--- by boss ---");
  assert.equal(arrow("press it more"), "-> press it more");
});

test("readout grammar: flag marks the WORSE side consistently, silent within noise", () => {
  // More-is-better metric (uptime): below peers -> WORSE.
  assert.match(flag(60, 75), /WORSE than peers/);
  assert.equal(flag(75, 60, { both: false }), "", "ahead, no positive flag by default");
  assert.match(flag(75, 60, { both: true }), /✓ better than peers/);
  // Lower-is-better metric (lost GCDs, latency): above peers -> WORSE.
  assert.match(flag(5.2, 4.2, { lowerIsBetter: true }), /WORSE than peers/);
  assert.equal(flag(4.2, 5.2, { lowerIsBetter: true }), "", "fewer lost GCDs than peers -> no nag");
  // Within noise -> silent (no flag spam on ~ties).
  assert.equal(flag(5.2, 5.1, { lowerIsBetter: true, noise: 0.5 }), "");
});
