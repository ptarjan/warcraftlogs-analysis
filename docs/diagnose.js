// Comparative timeline root-cause diagnosis. Ported from diagnose.py.
import { gql, PrivateReport } from "./wcl.js";
import {
  characterZone, characterEncounter, playerMetrics, topRankings, median, f, mapLimit,
} from "./core.js";


async function paginateEvents(code, fight, sourceId, dataType, abilityId = null, start = null, end = null) {
  const out = [];
  const ab = abilityId !== null ? `, abilityID: ${abilityId}` : "";
  let cursor = start;
  for (;;) {
    const stArg = cursor !== null && cursor !== undefined ? `, startTime: ${cursor}` : "";
    const enArg = end !== null && end !== undefined ? `, endTime: ${end}` : "";
    const q = `query { reportData { report(code:"${code}") { events(
      fightIDs:${fight}, sourceID:${sourceId}, dataType:${dataType}, limit:10000${ab}${stArg}${enArg}) {
      data nextPageTimestamp } } } }`;
    const ev = (await gql(q)).reportData.report.events;
    out.push(...ev.data);
    const nxt = ev.nextPageTimestamp;
    if (!nxt) break;
    cursor = nxt;
  }
  return out;
}

async function fightWindow(code, fight) {
  const q = `query { reportData { report(code:"${code}") {
    fights(fightIDs:${fight}) { startTime endTime } } } }`;
  const ff = (await gql(q)).reportData.report.fights[0];
  return [ff.startTime, ff.endTime];
}

function estimateGcd(gapsMs) {
  const normal = gapsMs.filter((g) => g >= 700 && g <= 1700);
  return normal.length ? median(normal) : 1500.0;
}

// Pure computation: timeline diagnostic for one actor on one fight.
async function fightMetrics(code, fight, sourceId) {
  const [fStart, fEnd] = await fightWindow(code, fight);
  const dur = (fEnd - fStart) / 1000.0;
  const castEvents = (await paginateEvents(code, fight, sourceId, "Casts", null, fStart, fEnd))
    .filter((e) => !e.fake);
  // Auto-attacks anchor the "in range vs not pressing" split. Melee = ability 1,
  // Hunters = Auto Shot (75). Casters have none -> hasAuto false, and we stop
  // claiming "out of range" (their gaps are casting/movement, not melee range).
  let autos = await paginateEvents(code, fight, sourceId, "DamageDone", 1, fStart, fEnd);
  if (!autos.length) autos = await paginateEvents(code, fight, sourceId, "DamageDone", 75, fStart, fEnd);
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
    dur, gcd, swing, n_gcds: merged.length,
    lost_not_pressing_s: lostNotPressing / 1000,
    lost_range_move_s: lostRangeMove / 1000,
    total_lost_s: totalLost / 1000,
    lost_per_min: (totalLost / 1000) / (dur / 60),
    range_lost_per_min: (lostRangeMove / 1000) / (dur / 60),
    press_lost_per_min: (lostNotPressing / 1000) / (dur / 60),
    auto_down_pct: 100 * autoDown / (dur * 1000),
    overshoot_ms: overshoot || 0,
    stalls,
  };
}

async function peerMetricsFor(encounterId, difficulty, className, specName, targetIlvl, n = 6) {
  const cands = [];
  for (let page = 1; page <= 7 && cands.length < n + 3; page++) {
    for (const r of await topRankings(encounterId, difficulty, className, specName, page)) {
      const il = r.bracketData;
      if (il && Math.abs(il - targetIlvl) <= 3) cands.push(r);
      if (cands.length >= n + 3) break;
    }
  }
  // fightMetrics paginates events (heavy), so a smaller concurrency cap.
  const results = await mapLimit(cands, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    return m ? fightMetrics(r.report.code, r.report.fightID, m.sourceID) : null;
  });
  return results.filter(Boolean).slice(0, n);
}

// Diagnose all your kills of a boss vs peer median on the SAME boss.
export async function compareBoss(name, server, region, encounter, difficulty, className, specName) {
  const er = await characterEncounter(name, server, region, encounter.id, difficulty);
  if (!er || !er.ranks || !er.ranks.length) return null;
  const perKill = await mapLimit(er.ranks, 4, async (rk) => {
    const you = await playerMetrics(rk.report.code, rk.report.fightID, name, specName, className);
    const fm = await fightMetrics(rk.report.code, rk.report.fightID, you.sourceID);
    return fm ? { fm, ilvl: rk.bracketData || 0 } : null;
  });
  const yourFms = perKill.filter(Boolean).map((x) => x.fm);
  const ilvls = perKill.filter(Boolean).map((x) => x.ilvl);
  if (!yourFms.length) return null;
  const peers = await peerMetricsFor(encounter.id, difficulty, className, specName,
    ilvls.length ? Math.max(...ilvls) : 0);
  const ymed = (k) => median(yourFms.map((x) => x[k]));
  const pmed = (k) => (peers.length ? median(peers.map((x) => x[k])) : NaN);
  const keys = ["lost_per_min", "range_lost_per_min", "press_lost_per_min", "auto_down_pct", "overshoot_ms"];
  const you = {}, peer = {};
  for (const k of keys) { you[k] = ymed(k); peer[k] = pmed(k); }
  return { boss: encounter.name, your_kills: yourFms.length, peers: peers.length, you, peer };
}

function printBossComparison(log, c) {
  log("");
  log(`  ${c.boss}  (your ${c.your_kills} kills vs ${c.peers} peers)`);
  const rows = [
    ["lost GCD time /min", "lost_per_min", "s"],
    ["  - out of range/moving /min", "range_lost_per_min", "s"],
    ["  - in range, not pressing /min", "press_lost_per_min", "s"],
    ["out-of-melee % of fight", "auto_down_pct", "%"],
    ["GCD overshoot (latency)", "overshoot_ms", "ms"],
  ];
  for (const [label, key, unit] of rows) {
    const y = c.you[key], p = c.peer[key];
    const delta = y - p;
    let flag = "";
    if (key !== "overshoot_ms" && delta > 1.0) flag = "  <-- WORSE than peers";
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
  const agg = { lost_per_min: [], range_lost_per_min: [], press_lost_per_min: [], auto_down_pct: [] };
  for (const r of ranks) {
    let comp;
    try {
      comp = await compareBoss(name, server, region, r.encounter, difficulty, className, specName);
    } catch (e) {
      log(`  (${r.encounter.name}: ${e.message || e})`);
      continue;
    }
    if (comp) {
      printBossComparison(log, comp);
      for (const k of Object.keys(agg)) agg[k].push(comp.you[k] - comp.peer[k]);
    }
  }
  if (agg.lost_per_min.length) {
    log("");
    log(`  === AGGREGATE excess vs peers (median across ${agg.lost_per_min.length} bosses) ===`);
    const sgn = (x) => (x >= 0 ? "+" : "") + f(x, 1);
    log(`    total lost GCD /min over peers: ${sgn(median(agg.lost_per_min))}s`);
    log(`      from out-of-range/moving:     ${sgn(median(agg.range_lost_per_min))}s`);
    log(`      from not pressing in range:   ${sgn(median(agg.press_lost_per_min))}s`);
    log(`    out-of-melee % over peers:      ${sgn(median(agg.auto_down_pct))} pts`);
  }
}
