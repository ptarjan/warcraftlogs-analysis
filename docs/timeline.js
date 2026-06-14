// @ts-check
// Comparative timeline root-cause analysis: where in the fight your DPS leaks
// vs ilvl-matched peers on the SAME boss (phase/intermission aware).
import { gql } from "./wcl.js";
import {
  characterZone, characterEncounter, playerMetrics, ilvlPeers, PEER_SAMPLE, median, f, mapLimit,
  fightWindow, fightEvents,
} from "./core.js";

function estimateGcd(gapsMs) {
  const normal = gapsMs.filter((g) => g >= 700 && g <= 1700);
  return normal.length ? median(normal) : 1500.0;
}

// Pure computation: timeline diagnostic for one actor on one fight.
async function fightMetrics(code, fight, sourceId, className = "Monk") {
  const [fStart, fEnd] = await fightWindow(code, fight);
  const dur = (fEnd - fStart) / 1000.0;
  // Casts + auto-attacks in one query. Autos anchor the "in range vs not pressing"
  // split (melee=ability 1, Hunters=Auto Shot 75; casters have none -> no autos,
  // so we stop claiming "out of range" -- their gaps are casting/movement).
  const { casts: castEvents, autos } = await fightEvents(code, fight, sourceId, fStart, fEnd);
  const hasAuto = autos.length > 0;
  const autoTs = autos.map((e) => e.timestamp).sort((a, b) => a - b);
  const castTs = castEvents.map((e) => e.timestamp).sort((a, b) => a - b);
  if (castTs.length < 5) return null;

  const merged = [castTs[0]];
  for (const t of castTs.slice(1)) if (t - merged[merged.length - 1] >= 250) merged.push(t);
  const gaps = [];
  for (let i = 0; i < merged.length - 1; i++) gaps.push(merged[i + 1] - merged[i]);
  const gcd = estimateGcd(gaps);
  const aswings = [];
  for (let i = 0; i < autoTs.length - 1; i++) aswings.push(autoTs[i + 1] - autoTs[i]);
  const underSwings = aswings.filter((s) => s < 5000);
  const swing = underSwings.length ? median(underSwings) : 2500;

  const autosIn = (t0, t1) => autoTs.filter((t) => t > t0 && t <= t1).length;

  let lostNotPressing = 0.0, lostRangeMove = 0.0;
  const stalls = [];
  const threshold = gcd * 1.4;
  for (let i = 0; i < merged.length - 1; i++) {
    const g = merged[i + 1] - merged[i];
    if (g <= threshold) continue;
    const excess = g - gcd;
    const expected = Math.max(1, (g - swing) / swing);
    const got = autosIn(merged[i], merged[i + 1]);
    // No autos (caster): can't tell range from idle -> count as a press gap,
    // never as "out of range".
    if (!hasAuto || got >= expected * 0.5) lostNotPressing += excess;
    else lostRangeMove += excess;
    stalls.push([merged[i] - fStart, g, got >= Math.max(1, expected) * 0.5]);
  }

  const overGaps = gaps.filter((g) => g >= gcd && g <= gcd + 600).map((g) => g - gcd);
  const overshoot = gaps.length ? median(overGaps) : 0;
  let autoDown = 0;
  if (autoTs.length > 1) {
    for (let i = 0; i < autoTs.length - 1; i++) {
      autoDown += Math.max(0, (autoTs[i + 1] - autoTs[i]) - swing * 1.5);
    }
  }
  const totalLost = lostNotPressing + lostRangeMove;
  return {
    dur, gcd, swing, nGcds: merged.length,
    lostNotPressingS: lostNotPressing / 1000,
    lostRangeMoveS: lostRangeMove / 1000,
    totalLostS: totalLost / 1000,
    lostPerMin: (totalLost / 1000) / (dur / 60),
    rangeLostPerMin: (lostRangeMove / 1000) / (dur / 60),
    pressLostPerMin: (lostNotPressing / 1000) / (dur / 60),
    autoDownPct: 100 * autoDown / (dur * 1000),
    overshootMs: overshoot || 0,
    stalls,
  };
}

async function peerMetricsFor(name, server, region, encounter, difficulty, className, specName) {
  const cands = await ilvlPeers(name, server, region, encounter, difficulty, className, specName);
  // fightMetrics paginates events (heavy), so a smaller concurrency cap.
  const results = await mapLimit(cands, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    return m ? fightMetrics(r.report.code, r.report.fightID, m.sourceID, className) : null;
  });
  return results.filter(Boolean).slice(0, PEER_SAMPLE);
}

// Diagnose all your kills of a boss vs peer median on the SAME boss.
// Your per-boss number is a median over your kills, so a few representative kills
// are as good as all of them -- but each extra kill costs ~5 WCL requests
// (metrics + timeline events). Re-analyzing every farm kill of the same boss is
// the single biggest, most redundant draw on the hourly budget; cap it.
const KILLS_PER_BOSS = 3;

export async function timelineFindings(name, server, region, encounter, difficulty, className, specName) {
  const er = await characterEncounter(name, server, region, encounter.id, difficulty);
  if (!er || !er.ranks || !er.ranks.length) return null;
  // Cap to a few kills, but the MOST RECENT ones (current gear/play) rather than
  // whatever order the ranks arrive in. Free -- just sorts the data we already have.
  const recentRanks = [...er.ranks].sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  const perKill = await mapLimit(recentRanks.slice(0, KILLS_PER_BOSS), 4, async (rk) => {
    const you = await playerMetrics(rk.report.code, rk.report.fightID, name, specName, className);
    const fm = await fightMetrics(rk.report.code, rk.report.fightID, you.sourceID, className);
    return fm ? { fm, ilvl: rk.bracketData || 0 } : null;
  });
  const yourFms = perKill.filter(Boolean).map((x) => x.fm);
  if (!yourFms.length) return null;
  // The ilvl-matched field -- via the shared core.ilvlPeers, so this can't drift
  // from overview's selection and start double-fetching the same peers.
  const peers = await peerMetricsFor(name, server, region, encounter, difficulty, className, specName);
  const ymed = (k) => median(yourFms.map((x) => x[k]));
  const pmed = (k) => (peers.length ? median(peers.map((x) => x[k])) : NaN);
  const keys = ["lostPerMin", "rangeLostPerMin", "pressLostPerMin", "autoDownPct", "overshootMs"];
  const you = {}, peer = {};
  for (const k of keys) { you[k] = ymed(k); peer[k] = pmed(k); }
  return { boss: encounter.name, yourKills: yourFms.length, peers: peers.length, you, peer };
}

function printBossComparison(log, c) {
  log("");
  log(`  ${c.boss}  (your ${c.yourKills} kills vs ${c.peers} peers)`);
  const rows = [
    ["lost GCD time /min", "lostPerMin", "s"],
    ["  - out of range/moving /min", "rangeLostPerMin", "s"],
    ["  - in range, not pressing /min", "pressLostPerMin", "s"],
    ["out-of-melee % of fight", "autoDownPct", "%"],
    ["GCD overshoot (latency)", "overshootMs", "ms"],
  ];
  for (const [label, key, unit] of rows) {
    const y = c.you[key], p = c.peer[key];
    const delta = y - p;
    let flag = "";
    if (key !== "overshootMs" && delta > 1.0) flag = "  <-- WORSE than peers";
    const sign = delta >= 0 ? "+" : "";
    log(`    ${label.padEnd(34)} you ${String(f(y, 1)).padStart(6)}${unit}  peer ${String(f(p, 1)).padStart(6)}${unit}  (${sign}${f(delta, 1)})${flag}`);
  }
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster",
  difficulty = 5, boss = null) {
  const c = await characterZone(name, server, region, difficulty);
  let ranks = (c.zoneRankings.rankings || []).filter(
    (r) => (r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined);
  if (boss) ranks = ranks.filter((r) => r.encounter.name.toLowerCase().includes(boss.toLowerCase()));
  log("");
  log(`=== Comparative timeline diagnosis: ${name} (vs ilvl-matched peers, intermissions cancel out) ===`);
  const agg = { lostPerMin: [], rangeLostPerMin: [], pressLostPerMin: [], autoDownPct: [] };
  for (const r of ranks) {
    let comp;
    try {
      comp = await timelineFindings(name, server, region, r.encounter, difficulty, className, specName);
    } catch (e) {
      log(`  (${r.encounter.name}: ${e.message || e})`);
      continue;
    }
    if (comp) {
      printBossComparison(log, comp);
      for (const k of Object.keys(agg)) agg[k].push(comp.you[k] - comp.peer[k]);
    }
  }
  if (agg.lostPerMin.length) {
    log("");
    log(`  === AGGREGATE excess vs peers (median across ${agg.lostPerMin.length} bosses) ===`);
    const sgn = (x) => (x >= 0 ? "+" : "") + f(x, 1);
    log(`    total lost GCD /min over peers: ${sgn(median(agg.lostPerMin))}s`);
    log(`      from out-of-range/moving:     ${sgn(median(agg.rangeLostPerMin))}s`);
    log(`      from not pressing in range:   ${sgn(median(agg.pressLostPerMin))}s`);
    log(`    out-of-melee % over peers:      ${sgn(median(agg.autoDownPct))} pts`);
  }
}
