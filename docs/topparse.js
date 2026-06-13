// "Chasing 99": the levers beyond your own play that separate a top parse from
// yours -- benchmarked against the actual top-ranked kills, not the median.
//   - RAID-COMP coverage: the standard class-provided damage amps your kill is
//     missing (Chaos Brand, Bloodlust, Power Infusion, Augmentation, ...).
//   - damage ROUTING: what the top parses cleave/funnel that you tunnel past.
//   - POTIONS: pre-pot + a second combat potion the top parses use.
//
// Why a curated table for comp (and not a generic "buffs you lack" diff): you
// CANNOT tell from a log alone whether an aura adds damage. A flat, always-on
// multiplier like Chaos Brand (+5% magic taken, a debuff ON THE BOSS, ~100%
// uptime) looks identical by uptime and by damage-concentration to pure utility
// like Atonement or a Soulstone. The only thing that separates them is knowing
// what the effect does -- so the damage-relevant raid amps and who brings each
// are listed explicitly. This is class UTILITY (a small, stable per-expansion
// list), NOT a spec's rotation/stat weights -- which is what the no-hard-coding
// rule is actually about.
import {
  playerMetrics, topRankings, buffUptimes, bossDebuffs, median, f, mapLimit, bestKill,
} from "./core.js";

const TOPN = 6; // how many top-ranked kills to learn routing/potions from

// The canonical raid-wide DAMAGE buffs/debuffs and who provides each. `on`:
// "self" = a buff on the player, "boss" = a debuff on the enemy (so it needs the
// boss's debuff table, not your buffs). `est` is a rough DPS-% used only to size
// the action-list item. Match by name keyword (like flask/food), tolerant of the
// rank/variant suffixes WoW buff names carry.
export const RAID_DAMAGE = [
  { key: "lust", label: "Bloodlust/Heroism", who: "a Shaman, Mage, Hunter, or Evoker", effect: "+30% haste burst", on: "self", est: 4, match: /bloodlust|heroism|time warp|primal rage|fury of the aspects|ancient hysteria|drums of/i },
  { key: "ai", label: "Arcane Intellect", who: "a Mage", effect: "+intellect", on: "self", est: 2, match: /arcane intellect/i },
  { key: "battleshout", label: "Battle Shout", who: "a Warrior", effect: "+attack power", on: "self", est: 2, match: /battle shout/i },
  { key: "motw", label: "Mark of the Wild", who: "a Druid", effect: "+versatility", on: "self", est: 2, match: /mark of the wild/i },
  { key: "skyfury", label: "Skyfury", who: "a Shaman", effect: "+mastery & attack power", on: "self", est: 2, match: /skyfury/i },
  { key: "pi", label: "Power Infusion", who: "a Priest (cast on you)", effect: "+25% haste burst", on: "self", est: 6, match: /power infusion/i },
  { key: "aug", label: "Augmentation (Ebon Might / Prescience)", who: "an Augmentation Evoker", effect: "re-attributed throughput", on: "self", est: 8, match: /ebon might|prescience|shifting sands/i },
  { key: "chaosbrand", label: "Chaos Brand", who: "a Demon Hunter", effect: "+5% magic damage taken", on: "boss", est: 5, match: /chaos brand/i },
  { key: "mystictouch", label: "Mystic Touch", who: "a Monk", effect: "+5% physical damage taken", on: "boss", est: 5, match: /mystic touch/i },
];

// --- pure, unit-tested helpers ----------------------------------------------

// Which canonical raid-damage amps were present on a kill, and which were
// missing. `selfBuffs` = aura map on the player; `boss` = aura map on the boss
// (or null if we couldn't read it -> boss-side amps are SKIPPED entirely, never
// guessed as missing). An amp counts as present when a matching aura is up for
// more than the threshold (self amps can be brief, e.g. Lust; boss debuffs are
// maintained, so they need real uptime).
export function raidCoverage(selfBuffs, boss, { minSelf = 1, minBoss = 20 } = {}) {
  const has = (auras, re, min) => Object.entries(auras || {}).some(([n, b]) => re.test(n) && b.pct > min);
  const present = [], missing = [];
  for (const e of RAID_DAMAGE) {
    if (e.on === "boss" && !boss) continue;          // couldn't read the boss -> don't guess
    const auras = e.on === "boss" ? boss : selfBuffs;
    (has(auras, e.match, e.on === "boss" ? minBoss : minSelf) ? present : missing).push(e);
  }
  return { present, missing };
}

// Share of damage that lands on NON-boss targets (cleave / funnel). The boss is
// the target whose name matches the encounter; everything else counts as adds.
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
export function potionCount(casts) {
  let n = 0;
  for (const [name, c] of Object.entries(casts || {})) if (/potion/i.test(name)) n += c;
  return n;
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

  // Raid-comp coverage on YOUR kill: buffs on you + debuffs on the boss. The boss
  // debuffs are a separate table; if it can't be read, those amps are skipped.
  const youBuffs = await buffUptimes(mine.code, mine.fight, you.sourceID);
  let youBoss = null;
  try { youBoss = await bossDebuffs(mine.code, mine.fight); } catch (e) { youBoss = null; }
  const comp = raidCoverage(youBuffs, youBoss);

  // Routing / potions: learn from the actual top-ranked kills (rank 1..N).
  const ranked = (await topRankings(mine.encounter.id, difficulty, className, specName, 1)).slice(0, TOPN);
  const tops = (await mapLimit(ranked, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    return m ? { m } : null;
  })).filter(Boolean);

  const youRoute = nonBossShare(you.dmg_targets, mine.encounter.name);
  let routing = null, potions = null;
  if (tops.length) {
    const topRoutes = tops.map((t) => nonBossShare(t.m.dmg_targets, mine.encounter.name));
    const addAgg = new Map();
    for (const r of topRoutes) for (const [nm, tot] of r.byAdd) addAgg.set(nm, (addAgg.get(nm) || 0) + tot);
    const youHits = new Set([...youRoute.byAdd.keys()]);
    const addNames = [...addAgg.entries()].sort((a, b) => b[1] - a[1])
      .map(([n]) => n).filter((n) => !youHits.has(n)).slice(0, 3);
    routing = { you: youRoute.pct, top: median(topRoutes.map((r) => r.pct)), addNames };
    potions = { you: potionCount(you.casts), top: Math.round(median(tops.map((t) => potionCount(t.m.casts)))) };
  }

  return {
    boss: mine.encounter.name, nTop: tops.length, yourPct: mine.rankPercent,
    bossReadable: youBoss !== null, comp, routing, potions,
  };
}

// --- card output -------------------------------------------------------------

export async function run(log, name, server, region, className, specName, difficulty) {
  const fnd = await topParseFindings(name, server, region, difficulty, className, specName);
  if (!fnd) { log("(couldn't build a top-parse comparison for this character)"); return; }

  log(`=== Chasing 99: you vs the top parses on ${fnd.boss} (your kill: ${f(fnd.yourPct, 0)}%ile) ===`);
  log("");

  log("--- Raid-comp damage amps (you can't press these -- it's who's in the raid) ---");
  if (!fnd.bossReadable) log("  (couldn't read the boss's debuffs -- boss-side amps like Chaos Brand omitted)");
  if (fnd.comp.missing.length) {
    for (const e of fnd.comp.missing) {
      log(`  MISSING  ${e.label.padEnd(34)} ${e.effect.padEnd(26)} bring ${e.who}`);
    }
  } else {
    log("  You have every standard raid-damage amp we can see.");
  }
  if (fnd.comp.present.length) log(`  Present: ${fnd.comp.present.map((e) => e.label).join(", ")}`);
  log("");

  if (fnd.routing) {
    log("--- Damage routing ---");
    log(`  top parses put ${f(fnd.routing.top, 0)}% of damage on non-boss targets; you ${f(fnd.routing.you, 0)}%.`);
    if (fnd.routing.addNames.length) log(`  they cleave/funnel that you don't: ${fnd.routing.addNames.join(", ")}`);
    log("");
    log("--- Consumables timing ---");
    log(`  potions/kill: top ${fnd.potions.top}, you ${fnd.potions.you}` +
        (fnd.potions.top > fnd.potions.you ? "  <-- pre-pot + a second combat potion" : ""));
  }
}
