// @ts-check
// Comparative timeline root-cause analysis: where in the fight your DPS leaks
// vs ilvl-matched peers on the SAME boss (phase/intermission aware).
import { gql } from "./wcl.js";
import {
  characterZone, characterEncounter, playerMetrics, ilvlPeers, PEER_SAMPLE, median, f, mapLimit, collectUpTo,
  fightWindow, fightEvents,
} from "./core.js";

function estimateGcd(gapsMs) {
  const normal = gapsMs.filter((g) => g >= 700 && g <= 1700);
  return normal.length ? median(normal) : 1500.0;
}

// Pure computation: timeline diagnostic for one actor on one fight.
async function fightMetrics(code, fight, sourceId, className = "Monk", { autoFallback = true } = {}) {
  const [fStart, fEnd] = await fightWindow(code, fight);
  const dur = (fEnd - fStart) / 1000.0;
  // Casts + auto-attacks in one query. Autos anchor the "in range vs not pressing"
  // split (melee=ability 1, Hunters=Auto Shot 75; casters have none -> no autos,
  // so we stop claiming "out of range" -- their gaps are casting/movement).
  // autoFallback:false skips the wasted hunter-Auto-Shot retry for known auto-less specs.
  const { casts: castEvents, autos } = await fightEvents(code, fight, sourceId, fStart, fEnd, { autoFallback });
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
    dur, gcd, swing, nGcds: merged.length, hasAuto,
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

async function peerMetricsFor(name, server, region, encounter, difficulty, className, specName, youHaveAutos = true) {
  const cands = await ilvlPeers(name, server, region, encounter, difficulty, className, specName);
  // fightMetrics paginates events (heavy), so a smaller concurrency cap. Stop once
  // PEER_SAMPLE succeed -- fetch the candidate buffer only to backfill failures. The
  // per-peer reportCore + timeline-event fetches in each wave run concurrently, so
  // gql() auto-batches them into one request each (no hand-bundling needed).
  return collectUpTo(cands, PEER_SAMPLE, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    // Peers share your spec: if YOU have no auto-attacks, skip their Auto-Shot retry.
    return m ? fightMetrics(r.report.code, r.report.fightID, m.sourceID, className, { autoFallback: youHaveAutos }) : null;
  });
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
    // Carry active% (uptime) alongside the timeline metrics -- the press-faster
    // lever must be judged against your TYPICAL uptime, not one low-uptime fight.
    return fm ? { fm, ilvl: rk.bracketData || 0, activePct: you.activePct } : null;
  });
  const kept = perKill.filter(Boolean);
  const yourFms = kept.map((x) => x.fm);
  if (!yourFms.length) return null;
  const activePcts = kept.map((x) => x.activePct).filter((x) => x != null);
  // Does this spec auto-attack at all? Learned from YOUR kills (with the fallback on).
  // Peers share your spec, so for an auto-less spec (casters) we skip their Auto-Shot
  // retry -- otherwise it's one empty fetch per peer per boss.
  const youHaveAutos = yourFms.some((fm) => fm.hasAuto);
  // The ilvl-matched field -- via the shared core.ilvlPeers, so this can't drift
  // from overview's selection and start double-fetching the same peers.
  const peers = await peerMetricsFor(name, server, region, encounter, difficulty, className, specName, youHaveAutos);
  // No ilvl-matched peers -> nothing to compare against. Skip the boss (like the
  // overview's "no item-level-matched peers found") instead of printing NaN deltas
  // and poisoning the cross-boss aggregate with them.
  if (!peers.length) return null;
  const ymed = (k) => median(yourFms.map((x) => x[k]));
  const pmed = (k) => median(peers.map((x) => x[k]));
  const keys = ["lostPerMin", "rangeLostPerMin", "pressLostPerMin", "autoDownPct", "overshootMs"];
  const you = {}, peer = {};
  for (const k of keys) { you[k] = ymed(k); peer[k] = pmed(k); }
  you.activePct = activePcts.length ? median(activePcts) : null;
  return { boss: encounter.name, yourKills: yourFms.length, peers: peers.length, you, peer };
}

function printBossComparison(log, c) {
  log("");
  log(`  ${c.boss}  (your ${c.yourKills} kills vs ${c.peers} peers)`);
  // Data-driven visibility -- skip rows with no signal so a caster (no autos: range
  // and out-of-melee are structurally 0, and "not pressing" just repeats the
  // headline) doesn't get two always-zero rows + a redundant split on every boss.
  // The range/press split only informs when there's real range loss; the
  // out-of-melee row only when something's actually off-target. Class-agnostic.
  const splitShown = Math.max(c.you.rangeLostPerMin, c.peer.rangeLostPerMin) >= 0.1;
  const meleeShown = Math.max(c.you.autoDownPct, c.peer.autoDownPct) >= 0.1;
  /** @type {Array<[string, string, string, boolean]>} */
  const rows = [
    ["lost GCD time /min", "lostPerMin", "s", true],
    ["  - out of range/moving /min", "rangeLostPerMin", "s", splitShown],
    ["  - in range, not pressing /min", "pressLostPerMin", "s", splitShown],
    ["out-of-melee % of fight", "autoDownPct", "%", meleeShown],
    ["GCD overshoot (latency)", "overshootMs", "ms", true],
  ];
  for (const [label, key, unit, show] of rows) {
    if (!show) continue;
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
    // Only break out the range/melee components when they carry signal -- a caster's
    // are structurally 0 (see printBossComparison), so don't print +0.0 rows.
    const aggRange = median(agg.rangeLostPerMin), aggMelee = median(agg.autoDownPct);
    if (Math.abs(aggRange) >= 0.1) {
      log(`      from out-of-range/moving:     ${sgn(aggRange)}s`);
      log(`      from not pressing in range:   ${sgn(median(agg.pressLostPerMin))}s`);
    }
    if (Math.abs(aggMelee) >= 0.1) log(`    out-of-melee % over peers:      ${sgn(aggMelee)} pts`);
  }
}
