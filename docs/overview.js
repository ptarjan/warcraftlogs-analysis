// @ts-check
// Overview + item-level / duration-controlled comparison vs the field.
import {
  DIFFICULTY, characterZone, characterEncounter, topRankings, playerMetrics,
  secondaryStats, gearSummary, median, topN, f, padL, padR, collectUpTo, bestRank,
  ilvlPeers, PEER_SAMPLE, metricUnit, recentKills, runIsHealer, mapLimit, BOSS_FANOUT,
} from "./core.js";

// The bug is a CONTRADICTION, not just a low kill: WCL brackets the pull at a DECENT
// %ile (so it survives kill-selection) yet your raw output is a tiny fraction of peers
// / you were barely active -- a death/late-join/short pull WCL scored leniently ("5k
// dps = 52%ile vs 190k peers"). A LOW-output + LOW-%ile kill is just a consistent bad
// kill (a 6%ile healer at 58k hps, a 25%ile DPS) -- SHOW it. So gate on rankPercent
// >= 40 (the kill claims you're OK) AND the output disagrees. Metric-agnostic.
export const isUnrepresentativeKill = (you, pmedActive, pmedDps, rankPercent) =>
  !!you && rankPercent != null && rankPercent >= 40 && (
    (pmedActive != null && you.activePct != null && you.activePct < pmedActive - 25)
    || (pmedDps > 0 && you.dps < pmedDps * 0.3));

export async function overview(log, name, server, region, difficulty) {
  const c = await characterZone(name, server, region, difficulty);
  const zr = c.zoneRankings;
  log("");
  log(`=== ${name}-${server} (${region}) | ${DIFFICULTY[difficulty] || difficulty} ===`);
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

// Your per-metric numbers for the SHARED ilvl-matched peer set (core.ilvlPeers --
// the single source so this can't drift from timeline's selection and start
// double-fetching). We map playerMetrics; timeline maps fightMetrics over the
// same candidates, so the reportCore fetches dedupe.
async function ilvlPeerMetrics(name, server, region, encounter, difficulty, className, specName) {
  const cands = await ilvlPeers(name, server, region, encounter, difficulty, className, specName);
  // Stop once we have PEER_SAMPLE good peers -- only fetch the candidate buffer to
  // backfill a failure, instead of fetching all 13 and slicing to 10 (saves points).
  return collectUpTo(cands, PEER_SAMPLE, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (m) m.rankDur = (r.duration || 0) / 1000;
    return m;
  });
}

// Full controlled comparison for one encounter (uses the best-ilvl kill).
async function deepCompare(log, name, server, region, encounter, difficulty, className, specName) {
  const er = await characterEncounter(name, server, region, encounter.id, difficulty);
  if (!er || !er.ranks || !er.ranks.length) return;
  const best = bestRank(er.ranks);
  const code = best.report.code, fight = best.report.fightID, ilvl = best.bracketData;
  const you = await playerMetrics(code, fight, name, specName, className);
  if (!you) return;

  const peers = await ilvlPeerMetrics(name, server, region, encounter, difficulty, className, specName);
  const pmed = (key) => median(peers.map((p) => p[key]).filter((v) => v !== null && v !== undefined));
  // The best-ILVL kill is the most-recent at your top item level -- which can be a
  // NON-REPRESENTATIVE pull: a death / late-join / ramp-killed fight where you did a
  // tiny fraction of your real output (a Shadow Priest's "5,045 dps, 38% active" while
  // peers do 190k). WCL still brackets it at a middling %ile, so a head-to-head reads
  // as a flat contradiction ("5k dps = 52%ile vs 190k peers"). Detect it (active far
  // below peers, or <30% of their DPS) and SKIP the misleading comparison -- the boss
  // parse% in the summary above is your real standing. Gear/trinket info still shows
  // (it's read off your character, valid regardless of how that pull went).
  const pmedActive = pmed("activePct"), pmedDps = pmed("dps");
  const outlier = peers.length && isUnrepresentativeKill(you, pmedActive, pmedDps, best.rankPercent);
  log("");
  log(`--- ${encounter.name} | your best-ilvl kill: ilvl ${ilvl}, ${f(you.dur, 0)}s, ${f(you.dps, 0)} ${metricUnit().toLowerCase()}, ${f(best.rankPercent, 0)}%ile ---`);
  if (!peers.length) {
    log("  (no item-level-matched peers found)");
    return;
  }
  if (outlier) {
    log(`  NOTE: this current-ilvl kill isn't representative -- ${f(you.dps, 0)} ${metricUnit().toLowerCase()} at ${f(you.activePct, 0)}% active vs peers' ${f(pmedActive, 0)}%, yet WCL scored it ${f(best.rankPercent, 0)}%ile (a death / late-join / short pull it bracketed leniently). Your real standing is the parse%ile in the summary above; skipping the head-to-head.`);
  } else {
    log(`  vs ${peers.length} ilvl-matched peers:`);
    log(`    ${padR(metricUnit() + ":", 13)} you ${padL(f(you.dps, 0), 9)}   peer med ${padL(f(pmed("dps"), 0), 9)}`);
    log(`    casts/min:    you ${padL(f(you.castsPerMin, 1), 9)}   peer med ${padL(f(pmed("castsPerMin"), 1), 9)}`);
    log(`    active %:     you ${padL(f(you.activePct, 1), 9)}   peer med ${padL(f(pmed("activePct"), 1), 9)}`);
    log(`    ${runIsHealer() ? "healed:      " : "targets hit:  "}you ${padL(you.targets, 9)}   peer med ${padL(f(pmed("targets"), 1), 9)}`);

    // Duration-controlled cut: peers whose kill time is within 40s of yours. Only
    // worth showing with a few of them -- a "median" of 1-2 just repeats the headline.
    const near = peers.filter((p) => Math.abs(p.dur - you.dur) <= 40).map((p) => p.dps);
    if (near.length >= 3) {
      log(`    ${metricUnit()} at your kill-time (+/-40s): you ${f(you.dps, 0)}  vs peer med ${f(median(near), 0)}  (n=${near.length})`);
    }
  }

  const youStats = await secondaryStats(code, fight, you.sourceID, className);
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
  const top4 = topN(peerTrinkets, 4).map((e) => e[0]);
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
  difficulty = 5, bosses = Infinity, inflation = false) {
  await overview(log, name, server, region, difficulty);
  // Deep-compare EVERY killed boss (most recent first). It's affordable because
  // each boss's peers + your-kill data come from the same fetches timeline already
  // makes for all bosses -- both go through core.ilvlPeers, so they pick the
  // identical peer set and the reportCore fetches coalesce.
  const recent = await recentKills(name, server, region, difficulty);
  // Fan the bosses out: each boss's peer discovery + reportCore/event fetches are
  // independent, so run them concurrently (the gql() batcher coalesces the resulting
  // misses) instead of boss-by-boss. deepCompare streams its lines, so buffer each
  // boss's output and flush IN ORDER -- identical printout, a fraction of the wall time.
  const bufs = await mapLimit(recent.slice(0, bosses), BOSS_FANOUT, async (r) => {
    const lines = [];
    try {
      await deepCompare((l = "") => lines.push(l), name, server, region, r.encounter, difficulty, className, specName);
    } catch (e) {
      lines.push(`  (${r.encounter.name}: ${e.message || e})`);
    }
    return lines;
  });
  for (const lines of bufs) for (const l of lines) log(l);
  if (inflation && recent.length) {
    await difficultyInflation(log, name, server, region, recent[0].encounter, className, specName);
  }
}
