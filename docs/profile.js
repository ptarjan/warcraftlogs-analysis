// Damage profile vs the field. Compares WHERE your damage comes from (% of total
// per ability) against ilvl-matched top players on the same boss. Big gaps
// surface build/rotation differences -- and unlike talents, damage-table
// abilities carry REAL names, so the output is actionable without any id mapping.
import {
  characterZone, characterEncounter, playerMetrics, topRankings, mapLimit, median, f,
} from "./core.js";

// {abilityName: total} -> {abilityName: % of total damage}.
function toPct(dmgBy) {
  const total = Object.values(dmgBy || {}).reduce((s, v) => s + v, 0) || 1;
  const out = {};
  for (const [a, v] of Object.entries(dmgBy || {})) out[a] = 100 * v / total;
  return out;
}

// Pure: per-ability share for you vs the field median, sorted by absolute gap.
export function profileDiff(youDmgBy, fieldDmgByList) {
  const youP = toPct(youDmgBy);
  const fieldP = (fieldDmgByList || []).map(toPct);
  const abilities = new Set(Object.keys(youP));
  for (const fp of fieldP) for (const a of Object.keys(fp)) abilities.add(a);
  const rows = [];
  for (const a of abilities) {
    const you = youP[a] || 0;
    const field = fieldP.length ? median(fieldP.map((fp) => fp[a] || 0)) : 0;
    rows.push({ ability: a, you, field, delta: you - field });
  }
  return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

// Your highest-ilvl kill = current build, with its damage breakdown.
async function yourBest(name, server, region, difficulty, className, specName) {
  const c = await characterZone(name, server, region, difficulty);
  const ranks = (c.zoneRankings.rankings || []).filter((r) => (r.totalKills || 0) > 0);
  let best = null;
  for (const r of ranks) {
    const er = await characterEncounter(name, server, region, r.encounter.id, difficulty);
    if (er && er.ranks && er.ranks.length) {
      const bk = er.ranks.reduce((a, b) => ((a.bracketData || 0) >= (b.bracketData || 0) ? a : b));
      const il = bk.bracketData || 0;
      if (!best || il > best.il) best = { il, code: bk.report.code, fight: bk.report.fightID, encounter: r.encounter };
    }
  }
  if (!best) return null;
  const m = await playerMetrics(best.code, best.fight, name, specName, className);
  return m ? { metrics: m, encounter: best.encounter, ilvl: best.il } : null;
}

async function fieldProfiles(encounterId, difficulty, className, specName, targetIlvl, n = 10) {
  const cands = [];
  for (let page = 1; page <= 5 && cands.length < n + 3; page++) {
    for (const r of await topRankings(encounterId, difficulty, className, specName, page)) {
      const il = r.bracketData;
      if (il && Math.abs(il - targetIlvl) <= 3) cands.push(r);
      if (cands.length >= n + 3) break;
    }
  }
  const ms = await mapLimit(cands, 5, (r) =>
    playerMetrics(r.report.code, r.report.fightID, r.name, specName, className));
  return ms.filter(Boolean).slice(0, n);
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster", difficulty = 5) {
  const you = await yourBest(name, server, region, difficulty, className, specName);
  if (!you) { log("(no kill found to read your damage profile)"); return; }
  const peers = await fieldProfiles(you.encounter.id, difficulty, className, specName, you.ilvl || 0);
  if (!peers.length) { log("(no ilvl-matched peers found for a damage-profile comparison)"); return; }

  const rows = profileDiff(you.metrics.dmg_by, peers.map((p) => p.dmg_by));
  log("");
  log(`=== Damage profile vs ${peers.length} ilvl-matched ${specName}s (${you.encounter.name}) ===`);
  // Only call out gaps of >= 3 percentage points; show the biggest handful.
  const big = rows.filter((r) => Math.abs(r.delta) >= 3).slice(0, 7);
  if (!big.length) {
    log("Your damage breakdown closely matches your peers -- no standout source gaps.");
    return;
  }
  log("Where your damage comes from differs most from your peers:");
  for (const r of big) {
    if (r.delta < 0)
      log(`  - ${r.ability}: peers ${f(r.field, 0)}% vs you ${f(r.you, 0)}%  -- under-using (a talent or rotation gap)`);
    else
      log(`  - ${r.ability}: you ${f(r.you, 0)}% vs peers ${f(r.field, 0)}%  -- over-relying`);
  }
}
