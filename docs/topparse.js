// "Chasing 99": benchmark you against the ACTUAL top-ranked kills, not the
// median field. Matching the median makes you a 50; the 99 recipe lives in the
// top parses. Surfaces the levers that separate a top parse from yours:
//   - external BUFFS/comp you're missing (Aug Evoker's Ebon Might, Power
//     Infusion, Bloodlust...) -- usually the single biggest driver, and not
//     something you fix by pressing buttons.
//   - damage ROUTING: what the top parses cleave/funnel that you tunnel past.
//   - POTIONS: pre-pot + a second combat potion the top parses use.
//
// Class-agnostic by construction: nothing is hard-coded. Buff names come
// straight from the data (so it finds Ebon Might / PI / Lust without a list),
// and the "boss vs adds" split uses the encounter name, not a per-tier table.
import {
  playerMetrics, topRankings, buffUptimes, median, f, mapLimit, bestKill,
} from "./core.js";

const TOPN = 6; // how many top-ranked kills to learn the recipe from

// --- pure, unit-tested helpers ----------------------------------------------

// Buffs the top parses have that you're missing or under-running. `youBuffs` is
// { name: {pct, guid} }; `topBuffsList` is one such map per top parse. A buff
// qualifies when the top parses keep it up (>= minTop%) and you're well behind
// (>= minGap below their median). `comp: true` marks buffs you had basically
// none of -- you can't apply them yourself, so it's a raid-comp/source gap, not
// execution. Names come from the data, so this finds Ebon Might / Power Infusion
// / Bloodlust with no hard-coded ability list.
// Consumable buffs you apply YOURSELF -- a gap here is a setup fix (eat/flask/pot),
// never a comp/source gap, no matter how low your uptime is.
const SELF_BUFF = /well fed|\bfood\b|flask|phial|potion|\brune\b|\boil\b|sharpening|weightstone|whetstone/i;

export function buffGaps(youBuffs, topBuffsList, { minTop = 40, minGap = 20 } = {}) {
  const names = new Set(topBuffsList.flatMap((b) => Object.keys(b || {})));
  const out = [];
  for (const name of names) {
    const top = median(topBuffsList.map((b) => (b && b[name] ? b[name].pct : 0)));
    const you = youBuffs && youBuffs[name] ? youBuffs[name].pct : 0;
    if (top >= minTop && top - you >= minGap) {
      const withGuid = topBuffsList.find((b) => b && b[name]);
      // comp = you have ~none AND you can't apply it yourself (a raid-source gap).
      out.push({ name, you, top, guid: withGuid ? withGuid[name].guid : null, comp: you < 5 && !SELF_BUFF.test(name) });
    }
  }
  return out.sort((a, b) => (b.top - b.you) - (a.top - a.you));
}

// Share of damage that lands on NON-boss targets (cleave / funnel). The boss is
// the target whose name matches the encounter; everything else counts as adds.
// Returns { pct, byAdd: Map(name -> total) }.
export function nonBossShare(targets, bossName) {
  let boss = 0, other = 0;
  const byAdd = new Map();
  for (const t of targets || []) {
    const tot = t.total || 0;
    if (bossName && t.name === bossName) boss += tot;
    else { other += tot; if (t.name) byAdd.set(t.name, (byAdd.get(t.name) || 0) + tot); }
  }
  const total = boss + other;
  return { pct: total ? (100 * other) / total : 0, byAdd };
}

// Total potions used in a kill, from the casts counter ({ abilityName: count }).
// Keyword match (like flask/food) -- no class assumptions.
export function potionCount(casts) {
  let n = 0;
  for (const [name, c] of Object.entries(casts || {})) if (/potion/i.test(name)) n += c;
  return n;
}

// Rough DPS-% estimate for a missing external buff, scaled by how much uptime
// the top parses get. Deliberately conservative and clamped; it exists only to
// order the action list sensibly (comp gaps are usually the biggest lever), and
// is always shown as an estimate.
export function compImpactPct(topUptime) {
  return Math.max(4, Math.min(14, Math.round((topUptime / 100) * 12)));
}

// --- data layer --------------------------------------------------------------

// The full top-parse comparison for your benchmark boss. Returns null when there
// isn't enough data (no kills, no top parses, private reports). The benchmark
// kill is your highest-ilvl kill (= current gear), via core.bestKill.
export async function topParseFindings(name, server, region, difficulty, className, specName) {
  const mine = await bestKill(name, server, region, difficulty);
  if (!mine) return null;
  const you = await playerMetrics(mine.code, mine.fight, name, specName, className);
  if (!you) return null;
  const youBuffs = await buffUptimes(mine.code, mine.fight, you.sourceID);

  // The 99 recipe: rank 1..N kills, not the ilvl-matched median.
  const ranked = (await topRankings(mine.encounter.id, difficulty, className, specName, 1)).slice(0, TOPN);
  const tops = (await mapLimit(ranked, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (!m) return null;
    const b = await buffUptimes(r.report.code, r.report.fightID, m.sourceID);
    return { m, b };
  })).filter(Boolean);
  if (!tops.length) return null;

  const gaps = buffGaps(youBuffs, tops.map((t) => t.b));

  const youRoute = nonBossShare(you.dmg_targets, mine.encounter.name);
  const topRoutes = tops.map((t) => nonBossShare(t.m.dmg_targets, mine.encounter.name));
  const topRoutePct = median(topRoutes.map((r) => r.pct));
  const addAgg = new Map();
  for (const r of topRoutes) for (const [nm, tot] of r.byAdd) addAgg.set(nm, (addAgg.get(nm) || 0) + tot);
  const youHits = new Set([...youRoute.byAdd.keys()]);
  const addNames = [...addAgg.entries()].sort((a, b) => b[1] - a[1])
    .map(([n]) => n).filter((n) => !youHits.has(n)).slice(0, 3);

  const topDps = median(tops.map((t) => t.m.dps));
  return {
    boss: mine.encounter.name,
    nTop: tops.length,
    yourPct: mine.rankPercent,
    dpsGapPct: you.dps ? (100 * (topDps - you.dps)) / you.dps : 0,
    buffGaps: gaps,
    routing: { you: youRoute.pct, top: topRoutePct, addNames },
    potions: { you: potionCount(you.casts), top: Math.round(median(tops.map((t) => potionCount(t.m.casts)))) },
  };
}

// --- card output -------------------------------------------------------------

export async function run(log, name, server, region, className, specName, difficulty) {
  const fnd = await topParseFindings(name, server, region, difficulty, className, specName);
  if (!fnd) { log("(couldn't build a top-parse comparison for this character)"); return; }

  log(`=== Chasing 99: you vs the top ${fnd.nTop} parses on ${fnd.boss} ===`);
  log(`Your kill sits at ${f(fnd.yourPct, 0)}%ile.` +
      (fnd.nTop < 3 ? "  (only a few top parses available -- treat as indicative)" : ""));
  log("");

  if (fnd.buffGaps.length) {
    log("--- External buffs (usually the biggest lever) ---");
    log(`  ${"buff".padEnd(28)} ${"top".padStart(5)}  ${"you".padStart(5)}`);
    for (const g of fnd.buffGaps.slice(0, 6)) {
      const flag = g.comp ? "  <-- COMP: a raid-comp/source gap, not execution" : "  <-- keep it up more";
      log(`  ${g.name.slice(0, 28).padEnd(28)} ${(f(g.top, 0) + "%").padStart(5)}  ${(f(g.you, 0) + "%").padStart(5)}${flag}`);
    }
  } else {
    log("External buffs: you match the top parses.");
  }
  log("");

  log("--- Damage routing ---");
  log(`  top parses put ${f(fnd.routing.top, 0)}% of damage on non-boss targets; you ${f(fnd.routing.you, 0)}%.`);
  if (fnd.routing.addNames.length) log(`  they cleave/funnel that you don't: ${fnd.routing.addNames.join(", ")}`);
  log("");

  log("--- Consumables timing ---");
  log(`  potions/kill: top ${fnd.potions.top}, you ${fnd.potions.you}` +
      (fnd.potions.top > fnd.potions.you ? "  <-- pre-pot + a second combat potion" : ""));
}
