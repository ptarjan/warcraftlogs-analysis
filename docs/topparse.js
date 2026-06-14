// @ts-check
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
  DPS, COMP, INFO, finding, runIsHealer, metricUnit,
} from "./core.js";
import { wowheadSpell } from "./links.js";

const TOPN = 6; // how many top-ranked kills to learn routing/potions from

// The canonical raid-wide DAMAGE buffs/debuffs and who provides each. `on`:
// "self" = a buff on the player, "boss" = a debuff on the enemy (so it needs the
// boss's debuff table, not your buffs). Match by name keyword (like flask/food),
// tolerant of the rank/variant suffixes WoW buff names carry.
// NO `est` here on purpose: the MAGNITUDE of a comp lever is MEASURED from the field
// (peers who had the amp vs not, on the run metric -- compDeltas), never a curated
// guess. The curated part is only WHICH auras are throughput amps + who brings them
// (you can't tell from a log alone that Chaos Brand adds damage); when the field gives
// no with/without split to measure, the lever is shown UNSIZED, not guessed.
// `spell` is the Wowhead spell id for a hover-tooltip link (verified against real
// report buff guids). Stable, expansion-level utility -- fine to carry here.
export const RAID_DAMAGE = [
  { key: "lust", label: "Bloodlust/Heroism", spell: 2825, who: "a Shaman, Mage, Hunter, or Evoker", effect: "+30% haste burst", on: "self", match: /bloodlust|heroism|time warp|primal rage|fury of the aspects|ancient hysteria|drums of/i },
  { key: "ai", label: "Arcane Intellect", spell: 1459, who: "a Mage", effect: "+intellect", on: "self", match: /arcane intellect/i },
  { key: "battleshout", label: "Battle Shout", spell: 6673, who: "a Warrior", effect: "+attack power", on: "self", match: /battle shout/i },
  { key: "motw", label: "Mark of the Wild", spell: 1126, who: "a Druid", effect: "+versatility", on: "self", match: /mark of the wild/i },
  { key: "skyfury", label: "Skyfury", spell: 462854, who: "a Shaman", effect: "+mastery & attack power", on: "self", match: /skyfury/i },
  { key: "pi", label: "Power Infusion", spell: 10060, who: "a Priest (cast on you)", effect: "+25% haste burst", on: "self", match: /power infusion/i },
  { key: "aug", label: "Augmentation (Ebon Might / Prescience)", spell: 395152, who: "an Augmentation Evoker", effect: "re-attributed throughput", on: "self", match: /ebon might|prescience|shifting sands/i },
  { key: "chaosbrand", label: "Chaos Brand", spell: 1490, who: "a Demon Hunter", effect: "+5% magic damage taken", on: "boss", match: /chaos brand/i },
  { key: "mystictouch", label: "Mystic Touch", spell: 113746, who: "a Monk", effect: "+5% physical damage taken", on: "boss", match: /mystic touch/i },
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
// the target whose name matches the encounter -- BUT encounter names often differ
// from the actual NPC name (council fights, renamed bosses), which would match
// nothing and mark EVERY target non-boss (a bogus "100%"). So when no target
// matches the name, fall back to the single biggest target = the primary boss.
export function nonBossShare(targets, bossName) {
  const list = (targets || []).filter((t) => (t.total || 0) > 0);
  if (!list.length) return { pct: 0, byAdd: new Map() };
  const hasNamed = bossName && list.some((t) => t.name === bossName);
  const biggest = list.reduce((a, b) => ((b.total || 0) > (a.total || 0) ? b : a));
  const isBoss = hasNamed ? (t) => t.name === bossName : (t) => t === biggest;
  let boss = 0, other = 0;
  const byAdd = new Map();
  for (const t of list) {
    const tot = t.total || 0;
    if (isBoss(t)) boss += tot;
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

  const youRoute = nonBossShare(you.dmgTargets, mine.encounter.name);
  let routing = null, potions = null;
  if (tops.length) {
    const topRoutes = tops.map((t) => nonBossShare(t.m.dmgTargets, mine.encounter.name));
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

  // Only surface routing/potions when there's a GAP to act on. "top 2% you 4%"
  // (you already route more) or "potions: top 0, you 0" are non-actionable noise.
  if (fnd.routing && fnd.routing.top - fnd.routing.you >= 1 && fnd.routing.addNames.length) {
    log("--- Damage routing ---");
    log(`  top parses put ${f(fnd.routing.top, 0)}% of damage on non-boss targets; you ${f(fnd.routing.you, 0)}%.`);
    log(`  they cleave/funnel that you don't: ${fnd.routing.addNames.join(", ")}`);
    log("");
  }
  if (fnd.potions && fnd.potions.top > fnd.potions.you) {
    log("--- Consumables timing ---");
    log(`  potions/kill: top ${fnd.potions.top}, you ${fnd.potions.you}  <-- pre-pot + a second combat potion`);
  }
}

// Findings for prescribe.js (chasing-99 domain): levers beyond your own play --
// the raid-comp amps your kill is missing, damage routing, and potion timing
// from the actual top parses -- as the shared { dim, impact, label, text }
// currency. Comp gaps are raid-dependent ("Comp"); potions are yours ("Setup").
export function topParseLevers(tp, compDeltas = null) {
  if (!tp) return [];
  const out = [];
  // Raid-comp amps missing from your kill (a buff on you / debuff on the boss).
  // You can't press these -- it's who's in the raid. The MAGNITUDE is MEASURED from
  // the field (peers who had the amp vs not, on the run metric -- compDeltas), a
  // confounded floor; we NEVER fall back to a curated guess. When the field gives no
  // with/without split (a near-universal amp, or a boss debuff we don't sample per
  // peer), the lever is shown UNSIZED (INFO) -- an honest roster note that claims 0
  // of the gap, rather than a fabricated %. (compDeltas only covers self-buffs today;
  // measuring boss debuffs per peer is a follow-up.)
  for (const e of (tp.comp ? tp.comp.missing : [])) {
    const cd = compDeltas && compDeltas[e.key];
    const link = wowheadSpell(e.spell, e.label);
    if (cd) {
      out.push(finding("Comp", COMP(Math.max(1, Math.round(cd.pct))),
        `Missing ${link} (${e.effect}) — bring ${e.who}. (measured: peers with it do ${Math.round(cd.pct)}% more ${metricUnit()}, n=${cd.nHave}/${cd.nNot}).`, "measured"));
    } else {
      out.push(finding("Comp", INFO,
        `Missing ${link} (${e.effect}) — bring ${e.who}. (unsized — this field gave no with/without split to measure it).`, "measured"));
    }
  }
  // Damage routing: measured extra cleave/funnel the top parses get. This is a
  // DPS-only lever -- it compares where you put your DAMAGE. For a healer it would
  // tell a Mistweaver to "cleave/funnel instead of tunneling the boss" to raise
  // their HPS, which is nonsense (their throughput is healing, not target choice).
  // Suppress entirely for healers, regardless of the broader healer-analysis design.
  const route = tp.routing ? tp.routing.top - tp.routing.you : 0;
  if (!runIsHealer() && tp.routing && route >= 5 && tp.routing.addNames.length) {
    out.push(finding("Comp", DPS(Math.round(route)),
      `ROUTING: top parses put ${f(tp.routing.top, 0)}% of damage on ${tp.routing.addNames.join(", ")} ` +
      `(you ${f(tp.routing.you, 0)}%). Cleave/funnel those instead of tunneling the boss.`, "measured"));
  }
  // Potions: pre-pot + a second combat potion (a setup fix you apply yourself).
  if (tp.potions && tp.potions.top > tp.potions.you) {
    out.push(finding("Setup", DPS(2),
      `POTIONS: top parses use ${tp.potions.top}/kill (pre-pot + a combat potion); you used ${tp.potions.you}. Add the missing one.`));
  }
  return out;
}
