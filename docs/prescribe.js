// Generate a concrete, prioritized prescription. Ported from prescribe.py.
// prescribe folds every analysis's findings (the shared { dim, impact, label,
// text } currency from core) into ONE sorted change-list. Each domain owns its
// own lever-construction (gearLevers/rotationLevers/topParseLevers); prescribe
// adds the cross-cutting ones (execution, consumables, enchants, stat gap) that
// need its own peer aggregates, then sorts + splits + renders.
import {
  ENCHANTABLE_SLOTS, characterZone, characterEncounter, playerMetrics,
  collectPeers, secondaryStats, buffUptimes, median, f, detectPriority, mapLimit, topEntry, bestRank,
  DPS, INFO, finding,
} from "./core.js";
import { timelineFindings } from "./timeline.js";
import { gearFindings, gearLevers } from "./gear.js";
import { wowheadSpell } from "./links.js";
import { rotationFindings, rotationLevers } from "./rotation.js";
import { topParseFindings, topParseLevers } from "./topparse.js";

const SLOT_NAME = ENCHANTABLE_SLOTS;

// A short headline for a finding (its keyword + first action clause), for naming
// the #1 lever in the synthesis without dumping the whole sentence.
export function rxHeadline(text) {
  const head = String(text).split(/ -- |;|\(/)[0].trim();
  return head.length > 72 ? head.slice(0, 69) + "…" : head;
}

async function bestIlvlKill(name, server, region, encounterId, difficulty) {
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  const best = bestRank(er && er.ranks);
  if (!best) return null;
  return [best.report.code, best.report.fightID, best.bracketData];
}

async function fieldGearConsumables(encounterId, difficulty, className, specName, targetIlvl, priority = "crit", n = 10) {
  const enchBySlot = {};   // slot -> Map(name -> count)
  const trinkets = new Map(), flasks = new Map(), foods = new Map(), potions = new Map(), augRunes = new Map(), oils = new Map();
  const guids = new Map(); // flask/food name -> spell guid (for Wowhead links)
  const statPcts = [];
  // Collect ilvl-matched candidates, then fetch each peer's gear/buffs/stats
  // concurrently (bounded) instead of one slow peer at a time.
  const cands = await collectPeers({ encounters: encounterId, difficulty, className, specName,
    limit: n + 3, pages: 7, ilvl: targetIlvl, window: 2 });
  const peers = (await mapLimit(cands, 5, async (r) => {
    const code = r.report.code, fight = r.report.fightID;
    const m = await playerMetrics(code, fight, r.name, specName, className);
    if (!m) return null;
    const bf = await buffUptimes(code, fight, m.sourceID);
    const s = await secondaryStats(code, fight, m.sourceID, className);
    return { m, bf, s };
  })).filter(Boolean).slice(0, n);

  for (const { m, bf, s } of peers) {
    for (const g of m.gear) {
      const slot = g.slot;
      if (slot in SLOT_NAME && g.permanentEnchantName) {
        const slotName = SLOT_NAME[slot];
        (enchBySlot[slotName] = enchBySlot[slotName] || new Map())
          .set(g.permanentEnchantName, (enchBySlot[slotName].get(g.permanentEnchantName) || 0) + 1);
      }
      if ((slot === 12 || slot === 13) && g.name) trinkets.set(g.name, (trinkets.get(g.name) || 0) + 1);
    }
    for (const [nm, b] of Object.entries(bf)) {
      const lc = nm.toLowerCase();
      if (b.pct > 50 && lc.includes("flask")) { flasks.set(nm, (flasks.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      if (b.pct > 50 && lc.includes("well fed")) { foods.set(nm, (foods.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      // Combat potions are brief (a few uses), so any uptime counts; exclude heals.
      if (b.pct > 0 && lc.includes("potion") && !lc.includes("healing")) { potions.set(nm, (potions.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      // Augment rune: a persistent +primary-stat consumable (a free flat gain).
      if (b.pct > 50 && lc.includes("augment rune")) { augRunes.set(nm, (augRunes.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      // Weapon oil / sharpening stone: a TEMPORARY weapon buff you re-apply, like
      // a flask -- NOT the permanent weapon enchant (that's the ENCHANTS check).
      if (b.pct > 50 && /\boil\b|sharpening|whetstone|weightstone/.test(lc)) { oils.set(nm, (oils.get(nm) || 0) + 1); guids.set(nm, b.guid); }
    }
    if (s) {
      const sec = ["crit", "haste", "mastery", "vers"].reduce((acc, k) => acc + s[k], 0) || 1;
      statPcts.push(100 * s[priority] / sec);
    }
  }
  return {
    enchBySlot, trinkets, flasks, foods, potions, augRunes, oils, guids,
    statPct: statPcts.length ? median(statPcts) : null, n: peers.length,
    dpsMed: peers.length ? median(peers.map((p) => p.m.dps)) : null, // measured field DPS
  };
}

async function mySetup(code, fight, sourceId, gear, priority = "crit", className = "Monk") {
  const bf = await buffUptimes(code, fight, sourceId);
  const flask = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("flask") && b.pct > 50);
  const food = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("well fed") && b.pct > 50);
  const potion = Object.entries(bf).find(([n, b]) => {
    const lc = n.toLowerCase();
    return lc.includes("potion") && !lc.includes("healing") && b.pct > 0;
  });
  const augrune = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("augment rune") && b.pct > 50);
  const oil = Object.entries(bf).find(([n, b]) => /\boil\b|sharpening|whetstone|weightstone/.test(n.toLowerCase()) && b.pct > 50);
  const stats = await secondaryStats(code, fight, sourceId, className);
  const statPct = stats
    ? 100 * stats[priority] / (["crit", "haste", "mastery", "vers"].reduce((a, k) => a + stats[k], 0) || 1)
    : null;
  const trinkets = gear.filter((g) => g.slot === 12 || g.slot === 13).map((g) => g.name);
  const ench = new Set(gear.filter((g) => g.slot in SLOT_NAME && g.permanentEnchant).map((g) => SLOT_NAME[g.slot]));
  return {
    flask: flask ? flask[0] : null, flaskGuid: flask ? flask[1].guid : null,
    food: food ? food[0] : null, foodGuid: food ? food[1].guid : null,
    potion: potion ? potion[0] : null, potionGuid: potion ? potion[1].guid : null,
    augrune: augrune ? augrune[0] : null, augruneGuid: augrune ? augrune[1].guid : null,
    oil: oil ? oil[0] : null, oilGuid: oil ? oil[1].guid : null,
    statPct, trinkets, ench,
  };
}

async function aggregateExecution(name, server, region, difficulty, className, specName, bosses) {
  const perBoss = [];
  for (const r of bosses) {
    let c;
    try { c = await timelineFindings(name, server, region, r.encounter, difficulty, className, specName); }
    catch (e) { c = null; }
    if (c) perBoss.push(c);
  }
  if (!perBoss.length) return null;
  const med = (key) => median(perBoss.map((c) => c.you[key] - c.peer[key]));
  const rangeBosses = perBoss
    .map((c) => [c.you.rangeLostPerMin - c.peer.rangeLostPerMin, c.boss])
    .sort((a, b) => b[0] - a[0]);
  return {
    nBosses: perBoss.length,
    pressExcess: med("pressLostPerMin"),
    rangeExcess: med("rangeLostPerMin"),
    totalExcess: med("lostPerMin"),
    overshootExcess: med("overshootMs"),
    worstRange: rangeBosses.filter(([d]) => d > 1.5).map(([, b]) => b),
  };
}

// Consumables you apply yourself -- one row per consumable, same logic for all:
// you ran none -> recommend the field's most common; you ran a different one ->
// swap to it. (Replaces five near-identical hand-written blocks.)
const CONSUMABLES = [
  { field: "flasks", mine: "flask", label: "FLASK", peerVerb: "run", note: "",
    none: DPS(2), missText: "you ran none", tail: "Free parse with equal gear.", swap: DPS(2) },
  { field: "foods", mine: "food", label: "FOOD", peerVerb: "run", note: "",
    none: DPS(1, 2), missText: "you ate none", tail: "Free parse.", swap: DPS(1) },
  { field: "potions", mine: "potion", label: "COMBAT POTION", peerVerb: "pop",
    note: " (pre-pull + again on cooldown/burst = 2 per fight)",
    none: DPS(1, 3), missText: "you used none", tail: "Free parse with equal gear.", swap: DPS(1) },
  { field: "augRunes", mine: "augrune", label: "AUGMENT RUNE", peerVerb: "use",
    note: " (a flat primary-stat gain)",
    none: DPS(1, 2), missText: "you ran none", tail: "Free parse.", swap: DPS(1) },
  { field: "oils", mine: "oil", label: "WEAPON OIL", peerVerb: "apply",
    note: " (a temporary weapon buff, re-applied like a flask)",
    none: DPS(1, 2), missText: "you ran none", tail: "Free parse.", swap: DPS(1) },
];

// --- cross-cutting levers prescribe builds from its OWN peer aggregates ------
// (gear/rotation/comp levers live in their domain modules; these need data only
// prescribe gathers: cross-boss execution, field consumables/enchants, stat gap.)
// Each returns Finding[].

function executionLevers(execd) {
  if (!execd) return [];
  const out = [];
  if (execd.pressExcess >= 1.0) {
    out.push(finding("Execution", DPS(Math.round(execd.pressExcess / 60 * 100)),
      `PRESS FASTER (every boss): you idle ~${f(execd.pressExcess, 1)}s/min MORE than peers while IN melee range -- not latency (yours matches theirs), just gaps between GCDs. Always queue your next ability so a GCD never sits empty.`));
  }
  if (execd.rangeExcess >= 1.0 || execd.worstRange.length) {
    const where = execd.worstRange.length ? " Worst on: " + execd.worstRange.join(", ") + "." : "";
    out.push(finding("Execution", DPS(Math.round(Math.max(execd.rangeExcess, 0.1) / 60 * 100)),
      `UPTIME on specific fights: you're out of melee ~${f(execd.rangeExcess, 1)}s/min more than peers (intermissions excluded).${where} Pre-position and use your mobility / gap-closers to stay on target through mechanics.`));
  }
  return out;
}

function consumableLevers(field, my) {
  const out = [];
  for (const cn of CONSUMABLES) {
    const counter = field[cn.field];
    if (!counter.size) continue;
    const top = topEntry(counter)[0];                        // field's most common, by count
    const mineName = my[cn.mine], mineGuid = my[cn.mine + "Guid"];
    if (!mineName) {
      out.push(finding("Setup", cn.none, `${cn.label}: ${cn.missText} -- ${counter.get(top)}/${field.n} peers ` +
        `${cn.peerVerb} ${wowheadSpell(field.guids.get(top), top)}${cn.note}. ${cn.tail}`));
    } else if (mineName !== top) {
      out.push(finding("Setup", cn.swap, `${cn.label}: ${wowheadSpell(mineGuid, mineName)} -> ${wowheadSpell(field.guids.get(top), top)}.`));
    }
  }
  return out;
}

// Missing enchants (the modern "oil"): slots the field reliably enchants that
// you left bare -- a free parse, same as a flask.
function enchantLevers(field, my) {
  const missing = [];
  for (const [slotName, counter] of Object.entries(field.enchBySlot)) {
    if (my.ench.has(slotName)) continue;                 // you already enchant this slot
    const top = topEntry(counter);
    if (top && top[1] >= field.n / 2) missing.push([slotName, top[0]]);  // field reliably enchants it
  }
  if (!missing.length) return [];
  const est = Math.min(missing.length, 5);
  const list = missing.map(([s, e]) => `${s} (${e})`).join(", ");
  return [finding("Setup", DPS(est), `ENCHANTS: you're missing enchants on ${list}. The field runs them -- a free parse with equal gear.`)];
}

// Your secondary % trails the field but there's no lever to close it -- either
// every item is already maxed for the stat (gear/comp-locked), or your gear is
// optimal for what you own. Only fires when gearLevers found no swap/restat
// (those ARE the actionable version of this gap).
function statGapLever(gf, my, field, priority) {
  const PRI = priority.toUpperCase();
  const statGap = (my.statPct !== null && field.statPct) ? field.statPct - my.statPct : 0;
  const hasGearLever = gf && (gf.swaps.length || gf.restats.length);
  if (statGap >= 4 && !hasGearLever) {
    return [finding("Gear", INFO, `${PRI}: yours (${f(my.statPct, 0)}%) is below your peers (${f(field.statPct, 0)}%), but NOT actionable now -- every item you own is already ${priority}-maxed and no ${priority}-itemized upgrade exists to swap to. It only rises when ${priority}-itemized drops come.`)];
  }
  if (gf && !gf.swaps.length && !gf.restats.length && statGap < 4) {
    return [finding("Gear", INFO, "GEAR/STATS: optimal for what you own -- no lever; gains are future drops + a sim (Droptimizer).")];
  }
  return [];
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster",
  difficulty = 5, knownPriority = null) {
  const c = await characterZone(name, server, region, difficulty);
  const ranks = (c.zoneRankings.rankings || []).filter(
    (r) => (r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined);
  if (!ranks.length) throw new Error("No kills found.");

  // Where you parse NOW -- the ground truth the player is trying to raise.
  const parses = ranks.map((r) => r.rankPercent).filter((x) => x != null);
  const medP = parses.length ? Math.round(median(parses)) : null;
  const topParse = ranks.reduce((a, b) => ((a.rankPercent || 0) >= (b.rankPercent || 0) ? a : b));
  const bestP = Math.round(topParse.rankPercent || 0);

  // Highest-ilvl kill = current gear.
  const kills = [];
  for (const r of ranks) {
    const bk = await bestIlvlKill(name, server, region, r.encounter.id, difficulty);
    if (bk) kills.push({ ilvl: bk[2] || 0, boss: r, code: bk[0], fight: bk[1] });
  }
  kills.sort((a, b) => b.ilvl - a.ilvl);
  const { ilvl: curIlvl, boss: gearBoss, code, fight } = kills[0];
  // Stat priority derived from what the field stacks -- never hard-coded. The
  // caller (app/CLI) already detected it; reuse it instead of re-sampling the
  // field's secondary stats (a whole peer fetch) again.
  const priority = knownPriority || await detectPriority(className, specName, difficulty, gearBoss.encounter.id);
  const you = await playerMetrics(code, fight, name, specName, className);
  const my = await mySetup(code, fight, you.sourceID, you.gear, priority, className);

  const field = await fieldGearConsumables(gearBoss.encounter.id, difficulty, className, specName, curIlvl, priority);
  const execd = await aggregateExecution(name, server, region, difficulty, className, specName, ranks);
  const gf = await gearFindings(name, server, region, difficulty, className, specName, priority);
  // rot/tp are hoisted so the synthesis below can quote their MEASURED numbers.
  // Each may be unavailable (private logs, no peers) -- treat that as no findings.
  let rot = null, tp = null;
  try { rot = await rotationFindings(name, server, region, className, specName, difficulty); }
  catch (e) { /* rotation data unavailable -- skip */ }
  try { tp = await topParseFindings(name, server, region, difficulty, className, specName); }
  catch (e) { /* top-parse data unavailable -- skip */ }

  // Fold every domain's levers into ONE list of findings, then sort biggest-DPS
  // first. impact is a real number, so the order can't disagree with the shown
  // labels (the old bug was sorting by a separate, stale key). Each domain owns
  // its own lever-building; prescribe just concatenates.
  const rx = [
    ...executionLevers(execd),
    ...consumableLevers(field, my),
    ...enchantLevers(field, my),
    ...gearLevers(gf, priority),
    ...statGapLever(gf, my, field, priority),
    ...rotationLevers(rot),
    ...topParseLevers(tp),
  ];
  rx.sort((a, b) => b.impact - a.impact);

  // THE SYNTHESIS: pull every analysis into one answer, anchored on the MEASURED
  // DPS gap (your kill vs the ilvl-matched field vs the top parses -- real numbers,
  // not a sum of per-lever guesses), then break that gap into measured facts. The
  // only place we estimate is gear (a stat -> DPS needs a sim), and we say so.
  const isComp = (r) => r.dim === "Comp";                  // raid-dependent, not yours to press
  const yours = rx.filter((r) => r.impact > 0 && !isComp(r));
  const k = (n) => `${f((n || 0) / 1000, 1)}k`;
  const peerGap = (you.dps && field.dpsMed) ? Math.round(((field.dpsMed - you.dps) / you.dps) * 100) : null;
  const topGap = (tp && tp.dpsGapPct) ? Math.round(tp.dpsGapPct) : null;

  log("");
  log("=".repeat(66));
  log(`HOW TO PARSE BETTER -- ${name}-${server} (${specName} ${className}), ilvl ~${curIlvl}`);
  log("=".repeat(66));
  if (medP != null) log(`You parse ${medP}th percentile overall (median of ${ranks.length} bosses; best ${bestP}th on ${topParse.encounter.name}).`);
  if (peerGap != null) {
    const vsField = peerGap > 0 ? `${peerGap}% behind` : `${Math.abs(peerGap)}% ahead of`;
    log(`Measured on ${gearBoss.encounter.name}: you do ${k(you.dps)} DPS -- ${vsField} the ilvl-matched field (${k(field.dpsMed)})` +
        (topGap != null ? `, ${topGap}% behind the top parses` : "") + `. That gap is your headroom.`);
  }
  if (yours.length) log(`Biggest fix YOU control: ${rxHeadline(yours[0].text)} -- start here.`);
  // What the gap is made of -- MEASURED quantities (no per-lever DPS guess).
  const facts = [];
  if (execd && execd.totalExcess >= 1) facts.push(`Execution -- you lose ${f(execd.totalExcess, 1)}s/min of GCD uptime vs peers`);
  if (rot && rot.usage && rot.usage.under.length) { const a = rot.usage.under[0]; facts.push(`Rotation -- you press ${a.name} ${f(a.you, 1)}/min vs the field's ${f(a.field, 1)}`); }
  if (tp && tp.routing && (tp.routing.top - tp.routing.you) >= 5) facts.push(`Routing -- ${f(tp.routing.you, 0)}% of your damage hits adds vs the top parses' ${f(tp.routing.top, 0)}%`);
  if (tp && tp.buffGaps) { const g = tp.buffGaps.find((x) => x.comp); if (g) facts.push(`Comp -- you're missing ${g.name} (${f(g.you, 0)}% vs ${f(g.top, 0)}% uptime; raid-dependent)`); }
  if (gf && gf.swaps.length) facts.push(`Gear -- ${gf.swaps.length} ${priority}-itemized upgrade${gf.swaps.length > 1 ? "s" : ""} the field runs (DPS value needs a sim)`);
  if (facts.length) { log("What the gap is made of (measured):"); for (const ff of facts) log(`  ${ff}`); }
  log(`(Field = top-ranked players at your item level; top parses = the rank-1 kills.)`);

  // Split the list by what's YOURS to do vs raid comp. The whole point is "what
  // do I do to my character right now" -- a roster gap (bring an Aug Evoker) is
  // real but isn't a change you make to your character, so it never competes for
  // the top of the to-do list; it's a clearly-labelled footnote. Each section
  // stays sorted biggest-DPS-first.
  const compList = rx.filter((r) => isComp(r));
  const youList = rx.filter((r) => !isComp(r));
  const line = (r, i) => log(`  ${i + 1}. [${r.label.padStart(9)}]  ${r.text}`);

  log("");
  log("DO THESE TO YOUR CHARACTER NOW (biggest first; gear/rotation % are sim estimates, the rest measured):");
  if (!youList.length) {
    log("  You match your peers on gear, enchants, consumables, stats, and execution. The rest is comp + farm kills.");
  }
  youList.forEach(line);

  if (compList.length) {
    log("");
    log("RAID COMP (real DPS, but a roster/buff gap -- NOT something you change on your character):");
    compList.forEach(line);
  }
  log("");
}
