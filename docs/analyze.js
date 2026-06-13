// Overview + item-level / duration-controlled comparison. Ported from analyze.py.
import {
  DIFFICULTY, characterZone, characterEncounter, topRankings, playerMetrics,
  secondaryStats, gearSummary, median, f, padL, padR, mapLimit,
} from "./core.js";
import { PrivateReport } from "./wcl.js";

export async function overview(log, name, server, region, difficulty) {
  const c = await characterZone(name, server, region, difficulty);
  const zr = c.zoneRankings;
  log("");
  log(`=== ${name}-${server} (${region}) | ${DIFFICULTY[difficulty] || difficulty} | zone ${zr.zone} ===`);
  log(`Best-avg %ile: ${f(zr.bestPerformanceAverage, 1)}   Median %ile: ${f(zr.medianPerformanceAverage, 1)}`);
  const killed = [];
  for (const r of (zr.rankings || [])) {
    if ((r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined) {
      killed.push(r);
      log(`  ${padR(r.encounter.name.slice(0, 28), 28)} ${padL(f(r.rankPercent, 1), 5)}%ile  (${r.totalKills} kills)`);
    }
  }
  return { zr, killed };
}

// Peers within +/- ilvlWindow of targetIlvl, with full metrics.
async function collectIlvlPeers(encounterId, difficulty, className, specName,
  targetIlvl, n = 12, ilvlWindow = 2, pages = 6) {
  const cands = [];
  for (let page = 1; page <= pages && cands.length < n + 4; page++) {
    for (const r of await topRankings(encounterId, difficulty, className, specName, page)) {
      const il = r.bracketData;
      if (il && Math.abs(il - targetIlvl) <= ilvlWindow) cands.push(r);
      if (cands.length >= n + 4) break;
    }
  }
  const metrics = await mapLimit(cands, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (m) m.rank_dur = (r.duration || 0) / 1000;
    return m;
  });
  return metrics.filter(Boolean).slice(0, n);
}

// Full controlled comparison for one encounter (uses the best-ilvl kill).
async function deepCompare(log, name, server, region, encounter, difficulty, className, specName) {
  const er = await characterEncounter(name, server, region, encounter.id, difficulty);
  if (!er || !er.ranks || !er.ranks.length) return;
  const best = er.ranks.reduce((a, b) => ((a.bracketData || 0) >= (b.bracketData || 0) ? a : b));
  const code = best.report.code, fight = best.report.fightID, ilvl = best.bracketData;
  const you = await playerMetrics(code, fight, name, specName, className);
  if (!you) return;
  log("");
  log(`--- ${encounter.name} | your best-ilvl kill: ilvl ${ilvl}, ${f(you.dur, 0)}s, ${f(you.dps, 0)} dps, ${f(best.rankPercent, 0)}%ile ---`);

  const peers = await collectIlvlPeers(encounter.id, difficulty, className, specName, ilvl || 0);
  if (!peers.length) {
    log("  (no item-level-matched peers found)");
    return;
  }
  const pmed = (key) => median(peers.map((p) => p[key]).filter((v) => v !== null && v !== undefined));

  log(`  vs ${peers.length} ilvl-matched peers:`);
  log(`    DPS:          you ${padL(f(you.dps, 0), 9)}   peer med ${padL(f(pmed("dps"), 0), 9)}`);
  log(`    casts/min:    you ${padL(f(you.casts_per_min, 1), 9)}   peer med ${padL(f(pmed("casts_per_min"), 1), 9)}`);
  log(`    active %:     you ${padL(f(you.active_pct, 1), 9)}   peer med ${padL(f(pmed("active_pct"), 1), 9)}`);
  log(`    targets hit:  you ${padL(you.targets, 9)}   peer med ${padL(f(pmed("targets"), 1), 9)}`);

  const near = peers.filter((p) => Math.abs(p.dur - you.dur) <= 40).map((p) => p.dps);
  if (near.length) {
    log(`    DPS at your kill-time (+/-40s): you ${f(you.dps, 0)}  vs peer med ${f(median(near), 0)}  (n=${near.length})`);
  }

  const youStats = await secondaryStats(code, fight, you.sourceID);
  if (youStats) {
    const keys = ["crit", "haste", "mastery", "vers"];
    const sec = keys.reduce((s, k) => s + youStats[k], 0) || 1;
    log("    secondary allocation (you): " + keys.map((k) => `${k} ${f(100 * youStats[k] / sec, 0)}%`).join("  "));
  }

  const g = gearSummary(you.gear);
  const miss = [...g.missing].sort();
  log(`    enchants missing: ${miss.length ? "[" + miss.map((x) => `'${x}'`).join(", ") + "]" : "none of the meta slots"}`);
  log(`    trinkets: [${g.trinkets.map((t) => `'${t}'`).join(", ")}]`);
  const peerTrinkets = new Map();
  for (const p of peers) for (const t of gearSummary(p.gear).trinkets) peerTrinkets.set(t, (peerTrinkets.get(t) || 0) + 1);
  const top4 = [...peerTrinkets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
  log(`    peer trinkets: [${top4.map((t) => `'${t}'`).join(", ")}]`);
}

// Quantify how much higher people parse on `low` vs `high` difficulty.
async function difficultyInflation(log, name, server, region, encounter, className, specName,
  high = 5, low = 4, sample = 12) {
  log("");
  log(`=== Difficulty inflation check on ${encounter.name} (${DIFFICULTY[low]} vs ${DIFFICULTY[high]}) ===`);
  const rows = [];
  const seen = new Set();
  for (const page of [1, 5, 12, 25]) {
    if (rows.length >= sample) break;
    for (const r of await topRankings(encounter.id, high, className, specName, page)) {
      const srv = r.server || {};
      if (srv.region !== region) continue;
      const key = `${r.name}|${srv.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let eh, em;
      try {
        eh = await characterEncounter(r.name, srv.name || "", region, encounter.id, low);
        em = await characterEncounter(r.name, srv.name || "", region, encounter.id, high);
      } catch (e) {
        continue;
      }
      const ph = eh && eh.ranks && eh.ranks.length ? eh.ranks[0].rankPercent : null;
      const pm = em && em.ranks && em.ranks.length ? em.ranks[0].rankPercent : null;
      if (ph !== null && ph !== undefined && pm !== null && pm !== undefined) {
        rows.push([r.name, pm, ph, ph - pm]);
      }
      if (rows.length >= sample) break;
    }
  }
  if (rows.length) {
    log(`  median ${DIFFICULTY[high]} %ile: ${f(median(rows.map((r) => r[1])), 0)}   ` +
      `median ${DIFFICULTY[low]} %ile: ${f(median(rows.map((r) => r[2])), 0)}   ` +
      `median inflation: ${f(median(rows.map((r) => r[3])), 0)} pts`);
  }
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster",
  difficulty = 5, bosses = 3, inflation = false) {
  const { killed } = await overview(log, name, server, region, difficulty);
  for (const r of killed.slice(0, bosses)) {
    try {
      await deepCompare(log, name, server, region, r.encounter, difficulty, className, specName);
    } catch (e) {
      log(`  (${r.encounter.name}: ${e.message || e})`);
    }
  }
  if (inflation && killed.length) {
    await difficultyInflation(log, name, server, region, killed[0].encounter, className, specName);
  }
}
