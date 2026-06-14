// @ts-check
// Generate a concrete, prioritized prescription. Ported from prescribe.py.
// prescribe folds every analysis's findings (the shared { dim, impact, label,
// text } currency from core) into ONE sorted change-list. Each domain owns its
// own lever-construction (gearLevers/rotationLevers/topParseLevers); prescribe
// adds the cross-cutting ones (execution, consumables, enchants, stat gap) that
// need its own peer aggregates, then sorts + splits + renders.
import {
  ENCHANTABLE_SLOTS, DIFFICULTY, characterZone, characterEncounter, playerMetrics,
  ilvlPeers, PEER_SAMPLE, secondaryStats, buffUptimes, median, f, detectPriority, mapLimit, topEntry, bestRank,
  DPS, INFO, finding, fieldDelta, metricUnit,
} from "./core.js";
import { timelineFindings } from "./timeline.js";
import { gearFindings, gearLevers, itemInstance, sourceText } from "./gear.js";
import { wowheadSpell, wowheadItem, wclReport } from "./links.js";
import { rotationFindings, rotationLevers } from "./rotation.js";
import { talentFindings, talentLevers } from "./talents.js";
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
  return [best.report.code, best.report.fightID, best.bracketData, best.startTime || 0, best.rankPercent];
}

// The kill to MEASURE the DPS gap against the field: the player's MEDIAN-parse kill
// within 1 ilvl of their top -- representative of TYPICAL performance at current
// gear. NOT the most-recent one: that can be an outlier (a tank's survival or
// progression kill where they barely DPS'd), producing an absurd "200% behind" gap
// that contradicts their own percentile. Median across the per-boss kills drops
// both the outlier-bad and the cherry-picked-best.
export function pickBenchmarkKill(kills, band = 1) {
  if (!kills || !kills.length) return null;
  const maxIl = Math.max(...kills.map((k) => k.ilvl || 0));
  const inBand = kills.filter((k) => (k.ilvl || 0) >= maxIl - band);
  if (!inBand.length) return null;
  const sorted = [...inBand].sort((a, b) => (a.rankPercent || 0) - (b.rankPercent || 0));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// "Current gear" = the most RECENT kill within `band` ilvls of your top, NOT the
// single highest-ilvl one. A peak-ilvl kill from weeks ago hides the enchant/gem/
// gear fixes you've made since (the classic stale-snapshot bug -- e.g. "my missing
// enchants were from weeks ago"). Mirrors core.bestRank, applied across every boss.
export function pickCurrentKill(kills, band = 1) {
  if (!kills || !kills.length) return null;
  const maxIl = Math.max(...kills.map((k) => k.ilvl || 0));
  return kills.filter((k) => (k.ilvl || 0) >= maxIl - band)
    .reduce((a, b) => ((b.startTime || 0) > (a.startTime || 0) ? b : a));
}

async function fieldGearConsumables(name, server, region, encounter, difficulty, className, specName, priority = "crit") {
  const enchBySlot = {};   // slot -> Map(name -> count)
  const trinkets = new Map(), flasks = new Map(), foods = new Map(), potions = new Map(), augRunes = new Map(), oils = new Map();
  const guids = new Map(); // flask/food name -> spell guid (for Wowhead links)
  const statPcts = [];
  // The ilvl-matched field, via the shared core.ilvlPeers (same set overview /
  // timeline / rotation use -- one fetch shared, not a divergent copy). Then fetch
  // each peer's gear/buffs/stats concurrently (bounded).
  const cands = await ilvlPeers(name, server, region, encounter, difficulty, className, specName);
  const peers = (await mapLimit(cands, 5, async (r) => {
    const code = r.report.code, fight = r.report.fightID;
    const m = await playerMetrics(code, fight, r.name, specName, className);
    if (!m) return null;
    const bf = await buffUptimes(code, fight, m.sourceID);
    const s = await secondaryStats(code, fight, m.sourceID, className);
    return { m, bf, s };
  })).filter(Boolean).slice(0, PEER_SAMPLE);

  for (const { m, bf, s } of peers) {
    for (const g of m.gear) {
      const slot = g.slot;
      if (slot in SLOT_NAME && g.permanentEnchantName) {
        const slotName = SLOT_NAME[slot];
        (enchBySlot[slotName] = enchBySlot[slotName] || new Map())
          .set(g.permanentEnchantName, (enchBySlot[slotName].get(g.permanentEnchantName) || 0) + 1);
      }
      // Tally trinkets by item id (a name can re-skin across ilvls); keep the name
      // for display. Trinkets are EFFECT-based, so they get their own lever (a
      // "sim this" candidate), never a stat-swap -- see trinketLevers / gear.js.
      if ((slot === 12 || slot === 13) && g.id) {
        const t = trinkets.get(g.id) || { name: g.name, count: 0 };
        t.count++; trinkets.set(g.id, t);
      }
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
  // Empirically value each lever from THIS ilvl-matched sample -- median DPS of
  // peers who have it vs who don't (fieldDelta). null where the field gives no
  // counterfactual (e.g. everyone flasks) -> the lever keeps its estimate.
  const dps = peers.map((p) => p.m.dps);
  const mask = (test) => peers.map((p) => Object.entries(p.bf || {}).some(([nm, b]) => test(nm.toLowerCase(), b)));
  const deltas = {
    flasks: fieldDelta(dps, mask((lc, b) => b.pct > 50 && lc.includes("flask"))),
    foods: fieldDelta(dps, mask((lc, b) => b.pct > 50 && lc.includes("well fed"))),
    potions: fieldDelta(dps, mask((lc, b) => b.pct > 0 && lc.includes("potion") && !lc.includes("healing"))),
    augRunes: fieldDelta(dps, mask((lc, b) => b.pct > 50 && lc.includes("augment rune"))),
    oils: fieldDelta(dps, mask((lc, b) => b.pct > 50 && /\boil\b|sharpening|whetstone|weightstone/.test(lc))),
  };
  // Priority-stat value: top-half vs bottom-half of the field's secondary %.
  const secOf = (s) => 100 * s[priority] / (["crit", "haste", "mastery", "vers"].reduce((a, k) => a + s[k], 0) || 1);
  const withStat = peers.map((p, i) => ({ pc: p.s ? secOf(p.s) : null, d: dps[i] })).filter((x) => x.pc != null && x.d > 0);
  let statDelta = null;
  if (withStat.length >= 8) {
    const medStat = median(withStat.map((x) => x.pc));
    statDelta = fieldDelta(withStat.map((x) => x.d), withStat.map((x) => x.pc >= medStat));
  }
  return {
    enchBySlot, trinkets, flasks, foods, potions, augRunes, oils, guids, deltas, statDelta,
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
  const myTrinkets = gear.filter((g) => g.slot === 12 || g.slot === 13);
  const trinkets = myTrinkets.map((g) => g.name);
  const trinketIds = new Set(myTrinkets.map((g) => g.id).filter(Boolean));
  const ench = new Set(gear.filter((g) => g.slot in SLOT_NAME && g.permanentEnchant).map((g) => SLOT_NAME[g.slot]));
  return {
    flask: flask ? flask[0] : null, flaskGuid: flask ? flask[1].guid : null,
    food: food ? food[0] : null, foodGuid: food ? food[1].guid : null,
    potion: potion ? potion[0] : null, potionGuid: potion ? potion[1].guid : null,
    augrune: augrune ? augrune[0] : null, augruneGuid: augrune ? augrune[1].guid : null,
    oil: oil ? oil[0] : null, oilGuid: oil ? oil[1].guid : null,
    statPct, trinkets, trinketIds, ench,
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
  // Each boss's number is a median over your kills of it; with a single kill the
  // "median" IS that one kill -- too noisy to name as a specific offender (the
  // repo's don't-trust-one-kill rule). Require >=2 kills to call a boss out, and
  // carry the count so the prescription can show how well-backed each callout is.
  const rangeBosses = perBoss
    .map((c) => [c.you.rangeLostPerMin - c.peer.rangeLostPerMin, c.boss, c.yourKills])
    .sort((a, b) => b[0] - a[0]);
  // Your TYPICAL uptime across bosses -- used to suppress press-faster when you're
  // already ~always active (one low-uptime fight shouldn't drive "you idle").
  const activePcts = perBoss.map((c) => c.you.activePct).filter((x) => x != null);
  return {
    nBosses: perBoss.length,
    pressExcess: med("pressLostPerMin"),
    rangeExcess: med("rangeLostPerMin"),
    totalExcess: med("lostPerMin"),
    overshootExcess: med("overshootMs"),
    activePct: activePcts.length ? median(activePcts) : null,
    worstRange: rangeBosses
      .filter(([d, , kills]) => d > 1.5 && kills >= 2)
      .map(([, b, kills]) => `${b} (${kills} kills)`),
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

// GCD overshoot (ms past the global) this much above peers reads as input latency
// rather than noise -- below it, it's not worth a callout.
const LATENCY_MS = 30;

// Input/queue latency: a high GCD overshoot vs peers means a delay after EVERY
// global before your next cast fires -- world latency, no spell-queue window, or
// reaction time. Tiny per-GCD but it's every GCD, so it compounds over a fight.
// Distinct from press-faster (idle gaps): this is the cast firing late, not not
// pressing. For a clean player (e.g. a caster who never moves) it's often the
// single biggest thing they actually control.
export function latencyLever(execd) {
  if (!execd || !(execd.overshootExcess >= LATENCY_MS)) return [];
  return [finding("Execution", DPS(1, 3),
    `INPUT LATENCY: your cast fires ~${f(execd.overshootExcess, 0)}ms later than peers after every GCD -- a small delay on each global that adds up over a fight. ` +
    `Raise your spell-queue window (Options > Combat, or /console SpellQueueWindow 300-400), cut world latency, and pre-press your next ability so it queues.`)];
}

export function executionLevers(execd, rot, peerGapPct = null, activePct = null) {
  if (!execd) return [];
  const out = [];
  // Size press-faster from the MEASURED cast deficit (you cast N fewer damaging
  // abilities/min than the field) when that's bigger than the idle-time proxy --
  // the idle-seconds estimate under-counts (it misses slow-but-not-idle play).
  // BUT a cast deficit does NOT convert 1:1 to DPS: the missing GCDs trend toward
  // lower-value fillers, some are non-damage presses, and part of the deficit IS
  // the rotation lever (a skipped core button lowers your cast count too). So damp
  // it (~half), cap at the actual headroom (the measured DPS gap to the field),
  // and hold a hard ceiling -- one execution lever must never claim the whole gap
  // (the old code piped the raw 44% cast gap straight in and dominated the list).
  const cg = rot && rot.castGap;
  const idlePct = Math.round(execd.pressExcess / 60 * 100);
  // The RESIDUAL cast deficit, after subtracting the abilities you're outright
  // MISSING (rot.usage.under -- the field presses them, you don't), is the part
  // that's genuinely "press faster" vs "press the right buttons". Counting the
  // whole deficit double-booked it with the rotation lever (Woeforged: a 12% press
  // lever AND a "press Shield of the Righteous" lever for the same missed casts).
  const under = (rot && rot.usage && rot.usage.under) || [];
  const underGap = under.reduce((s, a) => s + (a.gap || 0), 0);
  const speedPct = (cg && cg.field > 0)
    ? Math.round(100 * Math.max(0, (cg.field - cg.you) - underGap) / cg.field) : 0;
  // Is the press gap latency-driven? High GCD overshoot vs peers means the gaps
  // are a delay after each global (covered by latencyLever), not pure idling --
  // so don't tell them "it's not latency" when it actually is.
  const latencyHigh = execd.overshootExcess >= LATENCY_MS;
  // You can't out-press the field AND idle more than them. When the cast count
  // says you fire AS MANY or MORE damaging abilities/min than the field (no
  // deficit, speedPct<3), the idle-gap heuristic (pressLostPerMin) is contradicted
  // by harder evidence -- treat it as noise and DON'T raise press-faster. Leading
  // a 99%-active, out-casting player with "press faster" buries the real lever:
  // the gap is damage-PER-CAST (stats/gear/trinkets), not pressing. A genuine
  // deficit (speedPct>=3) still fires normally.
  // If you're essentially always active (high uptime), there's no idle to recover:
  // "press faster" is contradicted by your OWN uptime -- you can't idle ~2s/min
  // while 99% active. A cast deficit at high uptime is ability-MIX (defensive or
  // lower-APM GCDs, or the rotation lever), not idling. Class-agnostic -- catches a
  // 99.5%-active tank and a 99.2%-active DPS alike, without special-casing roles.
  const noIdle = activePct != null && activePct >= 98;
  const outpacesField = cg && cg.field > 0 && cg.you >= cg.field;
  if (!noIdle && (execd.pressExcess >= 1.0 || speedPct >= 3) && !(speedPct < 3 && outpacesField)) {
    const castEst = Math.round(speedPct / 2);
    const headroomCap = (peerGapPct && peerGapPct > 0) ? Math.max(1, Math.ceil(peerGapPct * 0.6)) : Infinity;
    const pct = Math.min(Math.max(idlePct, castEst) || 1, headroomCap, 12);
    // Only cite the cast rate as "lower" when it actually IS lower. A player can
    // idle more (pressExcess>=1) yet cast AS MANY or MORE damaging abilities/min
    // than the field (e.g. 69 vs 65) -- their idle gaps don't show up as a cast
    // deficit. In that case the deficit citation is false ("your lower cast rate
    // 69 vs 65"), so drop it; the measured idle-time headline stands on its own.
    const cite = (cg && cg.field > 0 && (speedPct >= 3 || cg.you < cg.field))
      ? (speedPct >= 3
          ? ` You cast ${f(cg.you, 0)} damaging abilities/min vs the field's ${f(cg.field, 0)} -- ~${speedPct}% of that is raw speed (the rest is the rotation fix); the % here estimates the DPS it's worth.`
          : ` (Your lower cast rate -- ${f(cg.you, 0)} vs ${f(cg.field, 0)}/min -- is mostly the rotation fix above, not raw speed.)`)
      : "";
    const cause = latencyHigh
      ? "gaps between GCDs (partly input latency -- see the INPUT LATENCY item)."
      : "not latency (yours matches theirs), just gaps between GCDs.";
    out.push(finding("Execution", DPS(pct),
      `PRESS FASTER (every boss): you idle ~${f(execd.pressExcess, 1)}s/min MORE than peers while IN melee range -- ${cause}${cite} Always queue your next ability so a GCD never sits empty.`, "measured"));
  }
  out.push(...latencyLever(execd));
  if (execd.rangeExcess >= 1.0 || execd.worstRange.length) {
    const where = execd.worstRange.length ? " Worst on: " + execd.worstRange.join(", ") + "." : "";
    out.push(finding("Execution", DPS(Math.round(Math.max(execd.rangeExcess, 0.1) / 60 * 100)),
      `UPTIME on specific fights: you're out of melee ~${f(execd.rangeExcess, 1)}s/min more than peers (intermissions excluded).${where} Pre-position and use your mobility / gap-closers to stay on target through mechanics.`, "measured"));
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
    // Prefer the MEASURED field delta (peers with it vs without) when the field
    // gives a counterfactual; else the category estimate. Both flagged honestly.
    const fd = field.deltas && field.deltas[cn.field];
    const noneScore = fd ? DPS(Math.round(fd.pct)) : cn.none;
    const basis = fd ? "measured" : "est";
    const cite = fd ? ` (measured: peers with it do ${Math.round(fd.pct)}% more, n=${fd.nHave}/${fd.nNot})` : "";
    if (!mineName) {
      out.push(finding("Setup", noneScore, `${cn.label}: ${cn.missText} -- ${counter.get(top)}/${field.n} peers ` +
        `${cn.peerVerb} ${wowheadSpell(field.guids.get(top), top)}${cn.note}.${cite} ${cn.tail}`, basis));
    } else if (mineName !== top) {
      out.push(finding("Setup", fd ? noneScore : cn.swap,
        `${cn.label}: ${wowheadSpell(mineGuid, mineName)} -> ${wowheadSpell(field.guids.get(top), top)}.`, basis));
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

// Trinkets are EFFECT-based (procs / on-use), so they can't be ranked by a stat
// sum like the other slots -- gear.js deliberately skips them. Surface them their
// own way: a trinket most of your ilvl-matched peers equip but you DON'T is a
// likely upgrade to SIM (Droptimizer), not a measured gain.
//
// CONFIDENCE comes from CONSENSUS, read off the data: if the field converges on
// one trinket (high share), a player missing it has a real lever; if trinket usage
// is spread across many different ones (low top share), there's no clear best -- so
// don't claim it, and never size it big. The displayed % scales with the share:
// near-unanimous is a real lever, a slim majority is only a weak hint.
export async function trinketLevers(field, my) {
  if (!field || !field.trinkets || !field.trinkets.size || field.n < 4) return [];
  const favored = [...field.trinkets.entries()]
    .map(([id, t]) => ({ id, name: t.name, count: t.count, share: t.count / field.n }))
    .filter((t) => !my.trinketIds.has(t.id) && t.share >= 0.6)   // a real majority, not a split field
    .sort((a, b) => b.share - a.share)
    .slice(0, 2);
  if (!favored.length) return [];
  // Size from the dominant trinket's share: ~unanimous -> 3%, strong -> 2%, slim -> 1%.
  const lead = favored[0].share;
  const pct = lead >= 0.85 ? 3 : lead >= 0.7 ? 2 : 1;
  const parts = [];
  for (const t of favored) {
    const inst = await itemInstance(t.id, null);           // resolve dungeon/raid from the item id
    parts.push(`${wowheadItem(t.id, t.name)} (${t.count}/${field.n} peers)${sourceText(null, inst, null)}`);
  }
  const yours = my.trinkets && my.trinkets.length ? my.trinkets.join(" + ") : "your current trinkets";
  return [finding("Gear", DPS(pct),
    `TRINKETS: the field favors ${parts.join(" and ")} -- you run ${yours}. Trinkets are effect-based (proc/on-use), not a stat swap -- SIM it (Droptimizer) before committing, but a trinket most of your peers run and you don't is a common hidden upgrade.`)];
}

// Your secondary % trails the field but there's no lever to close it -- either
// every item is already maxed for the stat (gear/comp-locked), or your gear is
// optimal for what you own. Only fires when gearLevers found no swap/restat
// (those ARE the actionable version of this gap).
function statGapLever(gf, my, field, priority) {
  const PRI = priority.toUpperCase();
  const statGap = (my.statPct !== null && field && field.statPct) ? field.statPct - my.statPct : 0;
  const hasGearLever = gf && (gf.swaps.length || gf.restats.length);
  if (statGap >= 4 && !hasGearLever) {
    // Measured value of the stat gap: how much more the field's top-half-of-stat
    // peers do. Cite it when we have it; it's context (no swap exists to act on).
    const sd = field && field.statDelta;
    const worth = sd ? ` Measured: peers in the top half of ${priority} do ${Math.round(sd.pct)}% more (n=${sd.nHave}/${sd.nNot}).` : "";
    return [finding("Gear", INFO, `${PRI}: yours (${f(my.statPct, 0)}%) is below your peers (${f(field.statPct, 0)}%), but NOT actionable now -- every item you own is already ${priority}-maxed and no ${priority}-itemized upgrade exists to swap to.${worth} It only rises when ${priority}-itemized drops come.`, sd ? "measured" : "est")];
  }
  if (gf && !gf.swaps.length && !gf.restats.length && statGap < 4) {
    return [finding("Gear", INFO, "GEAR/STATS: optimal for what you own -- no lever; gains are future drops + a sim (Droptimizer).")];
  }
  return [];
}

// A single reconciled percent label, e.g. "~11% DPS" (or "~<1% DPS").
const pctLabel = (n) => (n >= 0.5 ? `~${Math.round(n)}% ${metricUnit()}` : `~<1% ${metricUnit()}`);

// Reconcile the yours-list to the MEASURED headroom so the column ADDS UP to the
// gap instead of being a bag of independent guesses. `target` is the part of the
// measured gap that's plausibly yours (the gap minus comp, which keeps its own
// estimate and is a footnote). Three cases, all making concrete + residual == target:
//  - over-claim (our per-lever sims sum to MORE than the headroom): scale them
//    down so they can't claim more DPS than the gap actually is (this is what
//    shrinks a near-the-field player's list).
//  - under-explain: the leftover is an explicit unattributed residual (execution/
//    sim/variance) -- a player further behind gets a bigger one.
//  - no concrete levers: the whole target is residual.
// Pure math -> unit-testable; the framing of the residual is decided by the caller.
export function reconcileImpacts(impacts, target) {
  const rawSum = impacts.reduce((s, v) => s + (v || 0), 0);
  if (rawSum <= 0) return { scaled: impacts.slice(), residual: Math.max(0, target) };
  if (target <= 0) return { scaled: impacts.map(() => 0), residual: 0 };
  if (rawSum > target) return { scaled: impacts.map((v) => (v || 0) * target / rawSum), residual: 0 };
  return { scaled: impacts.slice(), residual: target - rawSum };
}

// THE SYNTHESIS, rendered: one answer anchored on the MEASURED DPS gap (your
// kill vs the ilvl-matched field vs the top parses -- real numbers, not a sum of
// per-lever guesses), what that gap is made of, then the change-list split into
// "yours to do" vs raid comp. Pure presentation -- the analysis already happened.
function renderPrescription(log, d) {
  const { rx, you, field, tp, execd, rot } = d;
  const isComp = (r) => r.dim === "Comp";                  // raid-dependent, not yours to press
  const yours = rx.filter((r) => r.impact > 0 && !isComp(r));
  const k = (n) => `${f((n || 0) / 1000, 1)}k`;
  const peerGap = (you && you.dps && field && field.dpsMed) ? Math.round(((field.dpsMed - you.dps) / you.dps) * 100) : null;
  const topGap = (tp && tp.dpsGapPct) ? Math.round(tp.dpsGapPct) : null;
  // You out-cast the field, so the "GCD uptime lost" heuristic is contradicted --
  // the REMAINDER below uses this to frame the gap as damage-per-cast, not activity.
  const outpaces = rot && rot.castGap && rot.castGap.field > 0 && rot.castGap.you >= rot.castGap.field;

  // No title line here -- the report hero (name · realm · region + spec/difficulty
  // pills) and the card's own "What to change" header already say who this is.
  // Quoted kills link straight to your Warcraft Logs report+fight.
  const bestBoss = d.topReport
    ? wclReport(d.topReport.code, d.topReport.fight, d.topParse.encounter.name) : d.topParse.encounter.name;
  const gearBossLink = wclReport(d.code, d.fight, d.gearBoss.encounter.name);
  if (d.medP != null) log(`You parse ${d.medP}th percentile on ${d.difficultyName} (median of the ${d.nBosses} current-tier ${d.difficultyName} boss${d.nBosses === 1 ? "" : "es"} you've killed; best ${d.bestP}th on ${bestBoss}).`);
  if (d.skipped && d.skipped.length) {
    log(`NOTE: partial list -- couldn't load ${d.skipped.join(", ")} (likely the WCL rate limit). This isn't the full picture; re-run when the budget resets for the rest.`);
  }
  // Staleness: gear/enchant/gem/consumable findings are read off your most recent
  // kill. If that's not actually recent, the setup findings may already be fixed.
  if (d.gearAgeDays != null && d.gearAgeDays >= 7) {
    log(`NOTE: your most recent ${d.difficultyName} kill is ~${d.gearAgeDays} days old (ilvl ${d.curIlvl}). The enchant/gem/gear/consumable findings reflect THAT kill -- if you've enchanted/re-gemmed/upgraded since, some are already done. Re-run after a fresh kill for an accurate setup check.`);
  }
  if (peerGap != null) {
    const ahead = peerGap <= 0;
    const vsField = ahead ? `${Math.abs(peerGap)}% ahead of` : `${peerGap}% behind`;
    // Spell out what the gap means: same-gear players already do it, so it's
    // gainable, and the list below is sized to sum to it.
    const tail = ahead
      ? ". You're already ahead of your item-level bracket -- the top parses are the target."
      : ` -- and they have your exact item level, so that ${peerGap}% is DPS you could realistically gain. The fixes below are sized to add up to it.`;
    log(`Measured on ${gearBossLink}: you (ilvl ~${d.curIlvl}) do ${k(you.dps)} ${metricUnit()} -- ${vsField} the ilvl-matched field (${k(field.dpsMed)})` +
        (topGap != null ? `, ${topGap}% behind the top parses` : "") + tail);
  }
  // A blunt, character-specific VERDICT: name the situation so the report never
  // reads like a template -- and always points at an action (respec / the few
  // setup fixes / "tighten your play, there's no shortcut").
  const compList0 = rx.filter(isComp);
  const setupFixes = yours.filter((r) => r.dim === "Gear" || r.dim === "Setup");
  const hasBuild = yours.some((r) => /^TALENTS\/BUILD/.test(r.text));
  if (hasBuild) {
    log("VERDICT: your biggest lever is a TALENT/BUILD fix -- you're not pressing an ability the field leans on (see #1). Sort that first, then do the free enchant/gear fixes below.");
  } else if (setupFixes.length) {
    // Only credit "pressing faster" when a press-faster lever survived -- for a
    // player who already out-casts the field it's suppressed, and the gap is
    // damage-per-cast (the gear/setup fixes), not activity.
    const hasPress = yours.some((r) => /PRESS FASTER/.test(r.text));
    log(`VERDICT: your build & rotation already match the field -- your character levers are the ${setupFixes.length} gear/setup fix${setupFixes.length > 1 ? "es" : ""} below${hasPress ? " + pressing faster" : ""}. The big gap is ${compList0.length ? "comp + " : ""}${hasPress ? "reps" : "damage-per-cast (stats/gear), not activity"}, not a setup overhaul.`);
  } else {
    log(`VERDICT: build, gear, enchants, and rotation all match the field -- there's NO setup or talent fix to make. Your gap is ${compList0.length ? "comp + " : ""}execution (press faster / uptime). Tighten your play; there's no gear/talent shortcut.`);
  }
  // (No "biggest fix" / "what the gap is made of" summary here -- the VERDICT
  // above names the situation and the numbered list below IS the breakdown,
  // sorted biggest-first with each lever's measured detail. Restating it read as
  // duplication.)
  log(`(Field = top-ranked players at your item level; top parses = the rank-1 kills.)`);

  // Split the list by what's YOURS to do vs raid comp. The whole point is "what
  // do I do to my character right now" -- a roster gap (bring an Aug Evoker) is
  // real but isn't a change you make to your character, so it never competes for
  // the top of the to-do list; it's a clearly-labelled footnote. Each section
  // stays sorted biggest-DPS-first.
  const compList = rx.filter((r) => isComp(r));
  const concrete = rx.filter((r) => r.impact > 0 && !isComp(r));   // sized fixes (sorted desc)
  const infoList = rx.filter((r) => r.impact === 0 && !isComp(r)); // INFO notes (no DPS, end)
  // Tag each line's basis so a number never masquerades: "measured" = from your
  // log (idle/uptime/routing/remainder); the rest are estimates a sim would price.
  const line = (r, i) => log(`  ${i + 1}. [${r.label.padStart(9)}]  ${r.text}${r.basis === "measured" ? "  [measured]" : "  [est.]"}`);

  // RECONCILE the change-list to the measured gap so it ADDS UP instead of being a
  // bag of independent guesses. gap = comp + your concrete fixes + an explicit
  // remainder. A player further behind ends up with bigger fixes / a bigger
  // remainder; one near the field has the whole list scaled down. Only when we
  // actually have a measured gap -- otherwise leave the honest sim ranges as-is.
  const gap = (peerGap != null && peerGap > 0) ? peerGap : 0;
  const compImpact = compList.reduce((s, r) => s + (r.impact || 0), 0);
  const renderYou = concrete.map((r) => ({ ...r }));
  let residual = 0, fixableTotal = 0;
  if (gap > 0) {
    const target = Math.max(0, gap - compImpact);                 // the plausibly-yours share
    const { scaled, residual: res } = reconcileImpacts(renderYou.map((r) => r.impact), target);
    renderYou.forEach((r, i) => { r.impact = scaled[i]; r.label = pctLabel(scaled[i]); });
    renderYou.sort((a, b) => b.impact - a.impact);
    residual = res;
    fixableTotal = scaled.reduce((s, v) => s + (v || 0), 0);      // your concrete, post-scale
  }
  // The remainder we can't pin to a specific fix. This is NOT just cosmetic: a big
  // remainder means the analysis FAILS to explain the measured gap -- usually a
  // real lever we don't model yet (the trinket lever was hiding here before we
  // built it), or a mis-measure (wrong benchmark kill, undercounted casts), not
  // "variance". So frame it by size + signal: under-pressing -> execution; a LARGE
  // unexplained chunk -> flag the list as incomplete; only a SMALL one is plausibly
  // sim/variance.
  if (gap > 0 && residual >= 1) {
    const r = Math.round(residual);
    // PRECEDENCE BY SIZE FIRST. A big remainder is the analysis admitting it can't
    // explain the gap -- it must NEVER be relabeled "press faster" (you can't
    // attribute 17% to a press-faster lever that's worth 4%). Only a small remainder
    // with a real cast deficit is credibly "press a bit faster".
    const underPress = (rot && rot.castGap && rot.castGap.field > rot.castGap.you)
      || (execd && execd.pressExcess >= 1 && !outpaces);
    let rtext;
    if (residual >= 8) {
      // A big remainder at matched ilvl is NOT a gear/sim gap (sims model gear, worth
      // a few % here) and NOT "press faster" -- it's PLAYSTYLE: how you play the same
      // gear vs the field (cooldown usage, ability frequency/sequencing, target &
      // uptime). Concrete cooldown/usage gaps now surface as their OWN levers above;
      // name any remaining rotation divergence we measured.
      const under = (rot && rot.usage && rot.usage.under) || [];
      const cite = under.length
        ? ` We can see part of it: you press ${under.slice(0, 2).map((a) => `${a.name} ${f(a.you, 1)}/min vs ${f(a.field, 1)}`).join(", ")}.`
        : ` Cooldown/ability-usage gaps we could measure are listed above; the rest is sequencing and target/uptime we don't yet break down — not a sim to run.`;
      rtext = `PLAYSTYLE (~${r}%): the biggest chunk, and it's NOT gear (a sim would value your gear swaps at a few %) and NOT "press faster" -- it's how you play the same gear the field plays.${cite}`;
    } else if (underPress) {
      rtext = `THE REMAINDER (~${r}%): not a setup item -- it's GCD uptime and hitting your priority on more pulls (see the measured cast/idle gaps above). That's where the rest of your gap lives.`;
    } else {
      rtext = `THE REMAINDER (~${r}%): small and unattributed -- sim-only tuning (exact trinket/stat effect sizes) and kill-to-kill variance. No single button.`;
    }
    renderYou.push({ dim: "Execution", impact: residual, label: pctLabel(residual), text: rtext, basis: "measured" });
  }
  const youOut = renderYou.concat(infoList);

  // Where your gap actually lives, in one line -- so a big gap with small per-item
  // fixes reads honestly (a player far behind on comp + diffuse setup shouldn't
  // look like they have nothing to do). Splits the measured gap into the part you
  // can fix, the raid-comp part, and what's still unexplained.
  if (gap > 0) {
    const compShare = Math.min(Math.round(compImpact), gap);
    log("");
    log(`Your ${gap}% gap breaks down as: ~${Math.round(fixableTotal)}pp you can fix (the list below)` +
        (compShare > 0 ? ` · ~${compShare}pp raid comp` : "") +
        (residual >= 1 ? ` · ~${Math.round(residual)}pp not yet explained` : "") + ".");
  }

  log("");
  log(gap > 0
    ? `--- Do these to your character now -- each % is that fix's share of your measured ${gap}% gap. [measured] = computed from your log; [est.] = a category/effect estimate a sim would price exactly ---`
    : "--- Do these to your character now (biggest first; [measured] = from your log, [est.] = sim would price it) ---");
  if (!youOut.length) {
    log("  You match your peers on gear, enchants, consumables, stats, and execution. The rest is comp + farm kills.");
  }
  youOut.forEach(line);

  if (compList.length) {
    log("");
    log("--- Raid comp (real DPS, but a roster/buff gap — NOT something you change on your character) ---");
    compList.forEach(line);
  }
  log("");
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster",
  difficulty = 5, knownPriority = null) {
  // Healers are analyzed on HEALING (the run metric is set to hps for healer
  // specs, so rankings/peers/throughput are all healing) -- the same prescription
  // machinery, just measuring HPS. No skip.
  const c = await characterZone(name, server, region, difficulty);
  const ranks = (c.zoneRankings.rankings || []).filter(
    (r) => (r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined);
  if (!ranks.length) throw new Error("No kills found.");

  // Where you parse NOW -- the ground truth the player is trying to raise.
  const parses = ranks.map((r) => r.rankPercent).filter((x) => x != null);
  const medP = parses.length ? Math.round(median(parses)) : null;
  const topParse = ranks.reduce((a, b) => ((a.rankPercent || 0) >= (b.rankPercent || 0) ? a : b));
  const bestP = Math.round(topParse.rankPercent || 0);

  // The kill we analyze: a REPRESENTATIVE (median-parse) kill near your top ilvl --
  // not the most-recent (which can be an outlier survival kill -> garbage gap) nor
  // the highest-ilvl (which can be weeks old -> stale setup). Within 1 ilvl, so gear
  // is current; the staleness NOTE below flags it if that kill is itself old.
  const kills = [];
  for (const r of ranks) {
    const bk = await bestIlvlKill(name, server, region, r.encounter.id, difficulty);
    if (bk) kills.push({ ilvl: bk[2] || 0, boss: r, code: bk[0], fight: bk[1], startTime: bk[3] || 0, rankPercent: bk[4] });
  }
  const { ilvl: curIlvl, boss: gearBoss, code, fight, startTime: gearKillStart } = pickBenchmarkKill(kills);
  // How old is that gear snapshot? Enchant/gem/gear/consumable findings reflect THIS
  // kill, so if it's stale, say so -- some may already be fixed.
  const gearAgeDays = gearKillStart ? Math.floor((Date.now() - gearKillStart) / 86400000) : null;
  // Stat priority derived from what the field stacks -- never hard-coded. The
  // caller (app/CLI) already detected it; reuse it instead of re-sampling the
  // field's secondary stats (a whole peer fetch) again.
  const priority = knownPriority || await detectPriority(className, specName, difficulty, gearBoss.encounter.id);
  // The PRESCRIPTION is the payoff -- it must survive a mid-run rate limit, not be
  // the section that gets cut. So EVERY data input is fail-soft: a throttled (or
  // private-log) fetch drops just its own levers, and we render the rest from what
  // we did get (often already cached by the earlier cards). Better a partial list
  // than nothing. The reason is logged so a thin list isn't mistaken for "clean".
  const skipped = [];
  const soft = async (what, p) => { try { return await p; } catch (e) { skipped.push(what); return null; } };
  let you = null, my = null;
  try {
    you = await playerMetrics(code, fight, name, specName, className);
    if (you) my = await mySetup(code, fight, you.sourceID, you.gear, priority, className);
  } catch (e) { skipped.push("your gear/consumables"); }

  const field = await soft("the peer field (consumables/enchants/stat gap)",
    fieldGearConsumables(name, server, region, gearBoss.encounter, difficulty, className, specName, priority));
  const execd = await soft("execution timeline",
    aggregateExecution(name, server, region, difficulty, className, specName, ranks));
  const gf = await soft("gear audit",
    gearFindings(name, server, region, difficulty, className, specName, priority));
  // rot/tp are hoisted so the synthesis below can quote their MEASURED numbers.
  // Each may be unavailable (private logs, no peers) -- treat that as no findings.
  let rot = null, tp = null, tal = null;
  try { rot = await rotationFindings(name, server, region, className, specName, difficulty); }
  catch (e) { skipped.push("rotation"); }
  try { tp = await topParseFindings(name, server, region, difficulty, className, specName); }
  catch (e) { skipped.push("top-parse comparison"); }
  try { tal = await talentFindings(name, server, region, className, specName, difficulty); }
  catch (e) { skipped.push("talents"); }

  // Fold every domain's levers into ONE list of findings, then sort biggest-DPS
  // first. impact is a real number, so the order can't disagree with the shown
  // labels (the old bug was sorting by a separate, stale key). Each domain owns
  // its own lever-building; prescribe just concatenates.
  // Measured DPS gap to the field -- the true headroom that caps the press-faster
  // estimate so no single execution lever can claim more than the whole gap.
  const peerGapPct = (you && you.dps && field && field.dpsMed) ? Math.round(((field.dpsMed - you.dps) / you.dps) * 100) : null;
  // Trinkets are effect-based, so they get their own (async, Wowhead-resolved)
  // lever instead of a stat swap -- compute it before the sync concat below.
  const trinketRx = (field && my) ? await trinketLevers(field, my) : [];
  /** @type {Finding[]} */
  const rx = [
    ...executionLevers(execd, rot, peerGapPct, (execd && execd.activePct != null) ? execd.activePct : (you && you.activePct)),
    ...(field && my ? consumableLevers(field, my) : []),
    ...(field && my ? enchantLevers(field, my) : []),
    ...trinketRx,
    ...gearLevers(gf, priority),
    ...(my ? statGapLever(gf, my, field, priority) : []),
    ...rotationLevers(rot),
    ...talentLevers(tal),
    ...topParseLevers(tp),
  ];
  rx.sort((a, b) => b.impact - a.impact);

  // Your report+fight for the best-percentile boss (so the header can link it).
  const topKill = kills.find((x) => x.boss.encounter.id === topParse.encounter.id);
  renderPrescription(log, {
    name, server, className, specName, curIlvl, gearBoss, code, fight,
    topReport: topKill ? { code: topKill.code, fight: topKill.fight } : null,
    difficultyName: DIFFICULTY[difficulty] || `difficulty ${difficulty}`,
    medP, bestP, topParse, nBosses: ranks.length, gearAgeDays,
    you, field, execd, rot, tp, gf, priority, rx, skipped,
  });
}
