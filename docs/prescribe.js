// @ts-check
// Generate a concrete, prioritized prescription. Ported from prescribe.py.
// prescribe folds every analysis's findings (the shared { dim, impact, label,
// text } currency from core) into ONE sorted change-list. Each domain owns its
// own lever-construction (gearLevers/rotationLevers/topParseLevers); prescribe
// adds the cross-cutting ones (execution, consumables, enchants, stat gap) that
// need its own peer aggregates, then sorts + splits + renders.
import {
  ENCHANTABLE_SLOTS, DIFFICULTY, characterZone, characterEncounter, playerMetrics,
  ilvlPeers, PEER_SAMPLE, secondaryStats, buffUptimes, prefetchBuffUptimes, bossDebuffs, median, f, detectPriority, mapLimit, collectUpTo, topEntry, bestRank, bestKill,
  DPS, INFO, finding, fieldDelta, metricUnit, throughputWord, runIsHealer, runIsSupport, healingBreakdown, manaStats,
} from "./core.js";
import { timelineFindings } from "./timeline.js";
import { gearFindings, gearLevers, itemInstance, sourceText } from "./gear.js";
import { wowheadSpell, wowheadItem, wclReport } from "./links.js";
import { rotationFindings, rotationLevers, castable } from "./rotation.js";
import { talentFindings, talentLevers } from "./talents.js";
import { topParseFindings, topParseLevers, RAID_DAMAGE } from "./topparse.js";
import { healingLevers } from "./healing.js";

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
  // Bundle the peers' buff-uptime tables into ONE request before the loop -- sourceID
  // rides the already-prewarmed reportCore, so building the specs is free. The +3
  // buffer stays lazy (collectUpTo); its buffs are fetched only if it's needed.
  const bSpecs = (await mapLimit(cands.slice(0, PEER_SAMPLE), 8, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    return m ? { code: r.report.code, fight: r.report.fightID, sourceId: m.sourceID } : null;
  })).filter(Boolean);
  await prefetchBuffUptimes(bSpecs);
  // Stop once PEER_SAMPLE succeed -- fetch the candidate buffer only to backfill failures.
  const peers = await collectUpTo(cands, PEER_SAMPLE, 5, async (r) => {
    const code = r.report.code, fight = r.report.fightID;
    const m = await playerMetrics(code, fight, r.name, specName, className);
    if (!m) return null;
    const bf = await buffUptimes(code, fight, m.sourceID);
    const s = await secondaryStats(code, fight, m.sourceID, className);
    return { m, bf, s };
  });

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
  // The value of the SPECIFIC field-favored item, for a SWAP (you ran a different
  // one -- e.g. a defensive flask vs the field's DPS flask). deltas above measure
  // having ANY (null when everyone flasks); these measure peers on the FIELD'S TOP
  // item vs not, so a wrong-choice swap can be priced from the field, not guessed.
  const topMaskDelta = (counter, thr) => {
    if (!counter.size) return null;
    const topName = topEntry(counter)[0];
    return fieldDelta(dps, peers.map((p) => Object.entries(p.bf || {}).some(([nm, b]) => nm === topName && b.pct > thr)));
  };
  const topDeltas = {
    flasks: topMaskDelta(flasks, 50), foods: topMaskDelta(foods, 50),
    potions: topMaskDelta(potions, 0), augRunes: topMaskDelta(augRunes, 50), oils: topMaskDelta(oils, 50),
  };
  // Priority-stat value: top-half vs bottom-half of the field's secondary %.
  const secOf = (s) => 100 * s[priority] / (["crit", "haste", "mastery", "vers"].reduce((a, k) => a + s[k], 0) || 1);
  const withStat = peers.map((p, i) => ({ pc: p.s ? secOf(p.s) : null, d: dps[i] })).filter((x) => x.pc != null && x.d > 0);
  let statDelta = null;
  if (withStat.length >= 8) {
    const medStat = median(withStat.map((x) => x.pc));
    statDelta = fieldDelta(withStat.map((x) => x.d), withStat.map((x) => x.pc >= medStat));
  }
  // Measured VALUE of the priority stat per RATING POINT, to size gear swaps from
  // the field instead of the ~75/point sim constant. Same ilvl, so more rating =
  // an itemization choice, not more gear: split peers at the median priority RATING
  // and price the DPS gap across the rating spread. Confounded -> a measured floor
  // (like the consumable deltas). null with no counterfactual -> swaps keep the est.
  const withRating = peers.map((p, i) => ({ r: p.s ? p.s[priority] : null, d: dps[i] })).filter((x) => x.r != null && x.d > 0);
  let statValue = null;
  if (withRating.length >= 8) {
    const medR = median(withRating.map((x) => x.r));
    const sd = fieldDelta(withRating.map((x) => x.d), withRating.map((x) => x.r >= medR));
    const spread = median(withRating.filter((x) => x.r >= medR).map((x) => x.r))
                 - median(withRating.filter((x) => x.r < medR).map((x) => x.r));
    if (sd && spread > 0) statValue = { pct: sd.pct, perRating: sd.pct / spread, nHave: sd.nHave, nNot: sd.nNot };
  }
  // Gem-choice value: peers running the field's most-common gem vs not (measured
  // like a consumable -- no fragile per-rating math, and the net stat-redistribution
  // is baked in because it's a real you-vs-the-field DPS delta).
  const gemTally = new Map();
  for (const { m } of peers) for (const g of (m.gear || [])) for (const gm of (g.gems || [])) if (gm.id) gemTally.set(gm.id, (gemTally.get(gm.id) || 0) + 1);
  let gemDelta = null;
  if (gemTally.size) {
    const topGem = [...gemTally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    gemDelta = fieldDelta(dps, peers.map((p) => (p.m.gear || []).some((g) => (g.gems || []).some((gm) => gm.id === topGem))));
  }
  // Raid-comp amp values from the SAME ilvl field: peers who had each self-buff vs
  // not. A measured floor (confounded -- a raid that brings an Aug also plays well),
  // null where there's no counterfactual -> the lever is shown UNSIZED, never guessed.
  // Boss-side debuffs (Chaos Brand, Mystic Touch) live on the ENEMY, not in a peer's
  // buff table -- they're measured separately + on demand (bossDebuffDeltas).
  const compDeltas = {};
  for (const e of RAID_DAMAGE) {
    if (e.on !== "self") continue;
    const d = fieldDelta(dps, peers.map((p) => Object.entries(p.bf || {}).some(([nm, b]) => e.match.test(nm) && b.pct > 1)));
    if (d) compDeltas[e.key] = d;
  }
  return {
    enchBySlot, trinkets, flasks, foods, potions, augRunes, oils, guids, deltas, topDeltas, statDelta, statValue, gemDelta, compDeltas,
    statPct: statPcts.length ? median(statPcts) : null, n: peers.length,
    dpsMed: peers.length ? median(peers.map((p) => p.m.dps)) : null, // measured field DPS
    // Field overheal % (median over the SAME peers) -- the baseline the healer
    // OVERHEALING lever measures your spill against. 0 for a damage field (harmless).
    overhealMed: peers.length ? median(peers.map((p) => p.m.overhealPct)) : null,
  };
}

// Boss-debuff comp value (Chaos Brand, Mystic Touch), MEASURED from the field the
// same way the self-buff deltas are -- but the debuff sits on the ENEMY, not in a
// peer's buff table, so it needs a per-peer Debuffs fetch (bossDebuffs). Only called
// for boss debuffs you're actually MISSING (usually none -- most raids bring a DH /
// Monk), so the extra request is paid ONLY when there's a lever to size. Re-uses the
// cached ilvlPeers + playerMetrics (free); only bossDebuffs is a new request per peer.
// Returns { key: fieldDelta } for the debuffs that split the field; absent (-> stays
// UNSIZED) when the field is near-universal on it (no with/without counterfactual).
async function bossDebuffDeltas(name, server, region, encounter, difficulty, className, specName, debuffs) {
  if (!debuffs.length) return {};
  const cands = await ilvlPeers(name, server, region, encounter, difficulty, className, specName);
  const peers = (await mapLimit(cands, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (!m || !(m.dps > 0)) return null;
    const db = await bossDebuffs(r.report.code, r.report.fightID);
    return { dps: m.dps, db };
  })).filter(Boolean);
  const dps = peers.map((p) => p.dps);
  const out = {};
  for (const e of debuffs) {
    const has = peers.map((p) => Object.entries(p.db || {}).some(([nm, b]) => e.match.test(nm) && b.pct > 1));
    const d = fieldDelta(dps, has);
    if (d) out[e.key] = d;
  }
  return out;
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
    // Name only the WORST few -- a list of every affected boss isn't actionable
    // (and when it's nearly all of them, it's a global habit, said once below).
    worstRange: rangeBosses
      .filter(([d, , kills]) => d > 1.5 && kills >= 2)
      .slice(0, 3)
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
  // HEALERS + SUPPORT: never "press faster". A healer's idle GCDs are correct play
  // (you can't heal damage that didn't happen), and a SUPPORT'S personal cast deficit
  // is mostly GCDs spent applying ally amps (Prescience/Ebon Might), not idling -- so
  // pushing personal cast speed mis-frames both. The idle time is absorbed by the
  // damage-bound / support remainder; their real levers are efficiency/buff-uptime.
  // latency + movement/uptime levers below still apply (out of range = real lost
  // output for either), so only this PRESS-FASTER push is suppressed.
  // A cast deficit only counts as "press faster" when you aren't ALREADY idling
  // LESS than peers in range (pressExcess < 0). If you out-press them in range yet
  // cast fewer/min, the missing casts are MOVEMENT (the uptime lever owns them) or
  // ability-MIX (rotation/remainder), not idle GCDs you can fill -- and a headline
  // "you idle ~-2.0s/min MORE" would flatly contradict the data (Dysphoric, Feral).
  const deficitIsPressable = speedPct >= 3 && execd.pressExcess >= 0;
  if (!runIsHealer() && !runIsSupport() && !noIdle && (execd.pressExcess >= 1.0 || deficitIsPressable) && !(speedPct < 3 && outpacesField)) {
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
    // Only claim "you idle MORE" when you measurably do (pressExcess positive). When
    // the lever fired on the cast deficit while your in-range idle MATCHES the field
    // (pressExcess ~0), the gap is micro-gaps between GCDs, not big pauses -- say that
    // instead of printing a ~0s/min (or contradictory negative) idle figure.
    const headline = execd.pressExcess >= 0.5
      ? `PRESS FASTER (every boss): you idle ~${f(execd.pressExcess, 1)}s/min MORE than peers while in range and not moving -- ${cause}${cite} Always queue your next ability so a GCD never sits empty.`
      : `PRESS FASTER (every boss): your damaging-cast rate trails the field even though your in-range idle matches theirs -- ${cause}${cite} Tighten the gaps between GCDs so each global fires the moment it's ready.`;
    out.push(finding("Execution", DPS(pct), headline, "measured"));
  }
  out.push(...latencyLever(execd));
  // Gate on a positive MEDIAN loss, not worstRange alone: a player who's fine on most
  // fights but bad on two has a negative/zero median -- printing "you lose ~-0.5s/min"
  // is misleading noise (telling someone who moves LESS than peers to move less). Below
  // ~0.5s/min the impact rounds to 0% anyway, so it only lengthens the list. worstRange
  // still enriches the line when it fires.
  if (execd.rangeExcess >= 0.5) {
    const where = execd.worstRange.length ? " Worst on: " + execd.worstRange.join(", ") + "." : "";
    // Class-agnostic: this is GCD lost to movement / being out of range, which is
    // a melee uptime problem AND a caster/healer one. Avoid melee-only language
    // ("out of melee", "gap-closers to stay on target") -- it's wrong for a ranged
    // healer, whom this lever also fires for.
    out.push(finding("Execution", DPS(Math.round(Math.max(execd.rangeExcess, 0.1) / 60 * 100)),
      `MOVEMENT uptime on specific fights: you lose ~${f(execd.rangeExcess, 1)}s/min of casting to moving / being out of range more than peers (intermissions excluded).${where} Pre-position and cut avoidable movement so your GCD keeps rolling through mechanics.`, "measured"));
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
      // Swap: price the SPECIFIC field-favored item (peers on it vs not), not the
      // have-any delta -- so "defensive flask -> the DPS flask" reads measured.
      const td = field.topDeltas && field.topDeltas[cn.field];
      const swapCite = td ? ` (measured: peers on it do ${Math.round(td.pct)}% more than those without, n=${td.nHave}/${td.nNot})` : "";
      out.push(finding("Setup", td ? DPS(Math.round(td.pct)) : cn.swap,
        `${cn.label}: ${wowheadSpell(mineGuid, mineName)} -> ${wowheadSpell(field.guids.get(top), top)}.${swapCite}`,
        td ? "measured" : "est"));
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

// What the unexplained remainder most likely IS, so we headline it honestly:
//  - "elite":      the player already parses top-decile, so the "field" (the TOP
//                  parses at their ilvl) is an elite sample and the remainder is the
//                  distance to it -- raid comp + optimal-pull execution, NOT a setup
//                  or rotation they're getting wrong. NEVER tell a 94th-%ile player
//                  the gap is "how you play the gear worse" -- it contradicts their
//                  own percentile and isn't actionable.
//  - "healer":     a big remainder on an HPS run -- HPS is bounded by the damage the
//                  raid TAKES and your healing assignment, so the gap to top healers
//                  is mostly the encounter + who else healed + overheal, NOT "how you
//                  play". Don't frame a healer's HPS gap as a personal playstyle deficit.
//  - "support":    a big remainder on a SUPPORT run (Augmentation) -- its throughput
//                  is the amps it puts on ALLIES (credited to their parses), so a
//                  personal-DPS gap mostly measures buff value the comparison can't
//                  see, NOT a personal playstyle deficit. (The buff-uptime lever is
//                  the part the support DOES control -- see the Support buffs card.)
//  - "playstyle":  a big remainder for a NON-elite DAMAGE player -- genuinely how they
//                  play the same gear the field plays (the tool's whole point).
//  - "underpress": a small remainder with a real cast deficit -- GCD uptime.
//  - "small":      a small remainder, no signal -- sim-only tuning + variance.
// Pure -> unit-testable; the caller turns the kind into prose. Precedence: elite
// (selection bias, applies to all roles) before healer before support before playstyle.
export function remainderKind(residual, { elite = false, healer = false, support = false, underPress = false } = {}) {
  if (residual >= 8) return elite ? "elite" : healer ? "healer" : support ? "support" : "playstyle";
  if (underPress) return "underpress";
  return "small";
}

// Already top-decile: a big remainder is the gap to the BEST at your ilvl, not a
// personal deficit. Top decile (90th+) is a conservative "this player isn't the
// problem" line.
export const isEliteParse = (medP) => medP != null && medP >= 90;

// Is the player on an OFF-META BUILD the field doesn't run? Signalled by a HERO TREE
// lever (talents.js fires it only when the field strongly favors the OTHER hero
// tree). When true, the rotation can't be compared button-for-button (no same-hero
// peers), so a big "playstyle" remainder is partly the off-meta build itself -- which
// the conservative talent/hero ESTIMATES above under-size -- not pure per-cast play.
export const isOffMetaBuild = (findings) => (findings || []).some((x) => /^HERO TREE/.test(x.text || ""));

// THE SYNTHESIS, rendered: one answer anchored on the MEASURED DPS gap (your
// kill vs the ilvl-matched field vs the top parses -- real numbers, not a sum of
// per-lever guesses), what that gap is made of, then the change-list split into
// "yours to do" vs raid comp. Pure presentation -- the analysis already happened.
// Which character lever the VERDICT should headline. `yours` MUST be the
// actionable findings sorted by impact desc (comp + the playstyle remainder
// excluded) -- yours[0] is the biggest lever, so the verdict can never claim a
// lever is "biggest / sort that first" when a bigger one outranks it in the list.
// A talent swap reads "TALENTS…" but is dim "Rotation", so check its text first.
export function verdictLever(yours) {
  const top = yours && yours[0];
  if (!top) return "none";
  if (/^TALENTS/.test(top.text)) return "build";
  if (top.dim === "Rotation") return "rotation";
  if (top.dim === "Gear" || top.dim === "Setup") return "setup";
  if (top.dim === "Execution") return "execution";
  return "none";
}

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
      : isEliteParse(d.medP)
      ? ` -- but the field here is the TOP parses at your item level, and at your ${d.medP}th percentile most of that gap is raid comp + execution on optimal pulls, not a setup you're getting wrong. The fixes below are the concrete part you control.`
      : runIsHealer()
      ? ` -- but ${metricUnit()} is capped by the damage your raid takes and your healing assignment, so most of that gap is the encounter and healer comp, not ${metricUnit()} you can simply add. The fixes below are the concrete part you control.`
      : runIsSupport()
      ? ` -- but as a support most of your value is the amps you keep on allies (credited to THEIR parses, not your personal DPS), so this personal-DPS gap mostly measures buff value, not DPS you can simply add. Your real lever is buff uptime (see the Support buffs card); the fixes below are the rest you control.`
      : ` -- and they have your exact item level, so that ${peerGap}% is ${metricUnit()} you could realistically gain. The fixes below are sized to add up to it.`;
    log(`Measured on ${gearBossLink}: you (ilvl ~${d.curIlvl}) do ${k(you.dps)} ${metricUnit()} -- ${vsField} the ilvl-matched field (${k(field.dpsMed)})` +
        (topGap != null ? `, ${topGap}% behind the top parses` : "") + tail);
  }
  // A blunt, character-specific VERDICT: name the situation so the report never
  // reads like a template -- and always points at an action (respec / the few
  // setup fixes / "tighten your play, there's no shortcut").
  const compList0 = rx.filter(isComp);
  const setupFixes = yours.filter((r) => r.dim === "Gear" || r.dim === "Setup");
  // Any talent/build change -- whether "TALENTS/BUILD" (a button you never press
  // because you skipped its talent) or "TALENTS" (the field runs a meta talent you
  // don't). Both are a build swap, the same VERDICT.
  const hasBuild = yours.some((r) => /^TALENTS/.test(r.text));
  // A talent/build swap reads "TALENTS…" but is dim "Rotation"; tell the play-lever
  // version apart so verbs ("respec" vs "play differently") never mismatch.
  const rotKindOf = (r) => /^EMPOWERMENT/.test(r.text) ? "an EMPOWERMENT timing fix (landing your hardest hit in its high-damage window)"
    : /^COOLDOWN/.test(r.text) ? "a COOLDOWN you under-use"
    : "a ROTATION/priority fix";
  // The VERDICT must name the ACTUAL biggest character lever. `yours` is sorted by
  // impact desc (rx.sort, comp + the playstyle remainder excluded), so yours[0] IS
  // it. Keying off a fixed category precedence (build > rotation > setup) was the
  // bug: a 3% talent swap got announced as "your biggest lever -- sort that first"
  // over an 8% rotation fix, contradicting the biggest-first list right above it.
  const lever = verdictLever(yours);
  // Other actionable categories present below the top one, named so the verdict
  // doesn't falsely claim "your build/gear already matches" when a fix exists.
  const extras = [];
  if (lever !== "build" && hasBuild) extras.push("a talent swap");
  if (lever !== "setup" && setupFixes.length) extras.push(`${setupFixes.length} gear/setup fix${setupFixes.length > 1 ? "es" : ""}`);
  const thenExtra = extras.length ? ` -- then ${extras.join(" and ")} below` : "";
  if (lever === "build") {
    const tail = setupFixes.length ? ", then do the free enchant/gear fixes below" : "";
    log(`VERDICT: your biggest character lever is a TALENT/BUILD change -- the field runs a build/talent you don't (see the TALENTS item). Sort that first${tail}.`);
  } else if (lever === "rotation") {
    log(`VERDICT: your biggest character lever is ${rotKindOf(yours[0])}${thenExtra}. The gap is mostly HOW you play the same gear, not a setup overhaul${compList0.length ? " (comp aside)" : ""}.`);
  } else if (lever === "execution") {
    log(`VERDICT: your biggest character lever is EXECUTION (uptime / pressing on time)${thenExtra}. The gap is HOW you play, not a setup overhaul${compList0.length ? " (comp aside)" : ""}.`);
  } else if (lever === "setup") {
    // Only credit "pressing faster" when a press-faster lever survived -- for a
    // player who already out-casts the field it's suppressed, and the gap is
    // damage-per-cast (the gear/setup fixes), not activity.
    const hasPress = yours.some((r) => /PRESS FASTER/.test(r.text));
    const buildNote = hasBuild ? " (plus a talent swap)" : "";
    // Metric-aware: a healer's residual gap is healing efficiency + damage-bound
    // throughput, never "damage-per-cast". (Same class of fix as the HPS metric-word
    // routing; "damage-per-cast" would leak a damage word into an HPS report.)
    const residualWord = hasPress ? "reps" : runIsHealer()
      ? "healing efficiency + throughput (stats/gear/comp), not activity"
      : "damage-per-cast (stats/gear), not activity";
    log(`VERDICT: your biggest character levers are the ${setupFixes.length} gear/setup fix${setupFixes.length > 1 ? "es" : ""} below${buildNote}${hasPress ? " + pressing faster" : ""}. The big gap is ${compList0.length ? "comp + " : ""}${residualWord}, not a rotation overhaul.`);
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
    const kind = remainderKind(residual, { elite: isEliteParse(d.medP), healer: runIsHealer(), support: runIsSupport(), underPress });
    let rtext;
    if (kind === "elite") {
      // Already top-decile: the remainder is the distance to the BEST parses at your
      // ilvl, not a setup/rotation you're getting wrong. Say so -- don't manufacture
      // an 86%-of-your-DPS "playstyle" problem for a 94th-%ile player.
      rtext = `GAP TO TOP PARSES (~${r}%): you already parse ${d.medP}th percentile -- the "field" here is the BEST players at your item level, and this is the distance to them. The concrete levers above are small because there isn't much on your character to fix; the rest is raid comp + executing on optimal pulls (lust/cooldown windows, perfect target swaps), not gear or a rotation you're getting wrong.`;
    } else if (kind === "healer") {
      // HPS is bounded by the damage the raid TAKES and your assignment -- you can't
      // heal damage that didn't happen. So a big HPS remainder is mostly the encounter
      // (how much went out), healer comp, and overheal, NOT a personal playstyle gap.
      // Don't tell a healer 100%+ of their gap is "how you play the gear worse".
      rtext = `HEALING IS DAMAGE-BOUND (~${r}%): HPS measures healing DONE, which is capped by the damage your raid takes and your healing assignment -- you can't out-heal damage that didn't happen. Most of this gap is the encounter (how much went out), the healer comp, and overheal differences, not how you play. The concrete levers above are what you actually control; chase effective throughput on a fixed kill, not the raw HPS number.`;
    } else if (kind === "support") {
      // A support's personal DPS is a fraction of their value: Ebon Might / Prescience
      // amp ALLIES, and WCL credits that damage to the allies' parses, not the support's.
      // So a big personal-DPS remainder mostly measures buff value the comparison can't
      // see -- NOT "how you play the gear worse". The part the support DOES control is
      // buff UPTIME (the Support buffs card / BUFF UPTIME levers), not personal damage.
      rtext = `SUPPORT VALUE IS OFF YOUR SHEET (~${r}%): your throughput is mostly the amps you keep on allies (Ebon Might / Prescience / Breath of Eons), which WCL credits to THEIR parses, not your personal DPS. So most of this gap isn't personal DPS you can add -- it's buff value a personal-DPS comparison can't see. What you DO control is buff UPTIME (keep your amps rolling -- see the Support buffs card) and your own cooldown/gear use above; chase those, not the raw personal-DPS number.`;
    } else if (kind === "playstyle") {
      // A big remainder at matched ilvl is NOT a gear/sim gap (sims model gear, worth
      // a few % here) and NOT "press faster" -- it's PLAYSTYLE. The concrete pieces
      // surface as their OWN levers above (a missed CAST you under-press; your big
      // hit landing in its high-damage window less). For the rest, we DIRECTLY check
      // empowerment with a measured fact: what share of your biggest hit lands
      // empowered vs the field. If yours trails -> point at it; if it MATCHES, say so
      // plainly -- the gap is per-cast damage (crit/stats + comp re-attribution and
      // this boss's damage-taken windows), NOT a button. Never hand-wave "sequencing".
      // Only cite under-pressed abilities the player can actually cast (the peer pool
      // can skew to a different hero tree -- that's a respec lever, not playstyle).
      const under = ((rot && rot.usage && rot.usage.under) || []).filter((a) => castable(a.name, rot && rot.talent));
      const pr = rot && rot.proc;
      const ep = (n) => `${Math.round(n * 100)}%`;
      // Only cite empowered shares when the ability HAS a meaningful empowered
      // version in the field (fieldEmp > ~5%); a uniform-hit ability (no empowered
      // form) would print a meaningless "0% vs 0%".
      const hasEmp = pr && pr.youEmp != null && pr.fieldEmp != null && pr.fieldEmp >= 0.05;
      const cite = hasEmp && pr.fieldEmp - pr.youEmp >= 0.12
        ? ` We can see the biggest piece: only ${ep(pr.youEmp)} of your ${pr.name} casts land empowered vs the field's ${ep(pr.fieldEmp)} (see the EMPOWERMENT item) -- the rest is per-cast ${throughputWord()} (crit/stats + comp & fight amps).`
        : hasEmp
        ? ` We checked the obvious culprit: your ${pr.name} lands empowered ${pr.youEmp >= pr.fieldEmp ? "as often as" : "nearly as often as"} the field (you ${ep(pr.youEmp)} vs ${ep(pr.fieldEmp)}), so it's NOT timing -- the gap is per-cast ${throughputWord()} (crit/stat scaling, plus comp re-attribution and fight amp windows you don't fully control).`
        : under.length
        ? ` We can see part of it: you press ${under.slice(0, 2).map((a) => `${a.name} ${f(a.you, 1)}/min vs ${f(a.field, 1)}`).join(", ")}.`
        : ` The cooldown/ability gaps we could measure are listed above; the rest is per-cast ${throughputWord()} (crit/stats + comp & fight amps) we can't pin to one ability.`;
      // Off-meta build: the field runs a different hero tree, so we have NO same-hero
      // peers to compare your rotation against -- a big part of this remainder is the
      // build itself (the HERO TREE + TALENTS items, conservatively estimated above),
      // not "how you play the same gear". Lead with that instead of mis-calling it
      // pure per-cast playstyle. (Rezaa: Colossus Arms vs a 100%-Slayer field.)
      rtext = isOffMetaBuild(rx)
        ? `OFF-META BUILD + PLAYSTYLE (~${r}%): the biggest chunk, and a large part is your BUILD -- you run a hero tree (and talents) the field doesn't (see the HERO TREE + TALENTS items), so we can't compare your rotation to theirs button-for-button and a sim would value the build swap well above the small estimate above. Switch to the meta build and re-run first.${cite}`
        : `PLAYSTYLE (~${r}%): the biggest chunk, and it's NOT gear (a sim would value your gear swaps at a few %) and NOT "press faster" -- it's how you play the same gear the field plays.${cite}`;
    } else if (kind === "underpress") {
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
    log(`--- Raid comp (real ${metricUnit()}, but a roster/buff gap — NOT something you change on your character) ---`);
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
  const { ilvl: curIlvl, boss: gearBoss, code, fight } = pickBenchmarkKill(kills);
  // The PRESCRIPTION is the payoff -- it must survive a mid-run rate limit, not be
  // the section that gets cut. So EVERY data input is fail-soft: a throttled (or
  // private-log) fetch drops just its own levers, and we render the rest from what
  // we did get (often already cached by the earlier cards). Better a partial list
  // than nothing. The reason is logged so a thin list isn't mistaken for "clean".
  const skipped = [];
  const soft = async (what, p) => { try { return await p; } catch (e) { skipped.push(what); return null; } };
  // SETUP (gear/enchants/gems/trinkets/consumables) is read off the SAME kill the
  // gear audit / rotation / talents use -- core.bestKill (your most RECENT kill at
  // current gear) -- NOT the benchmark kill. The benchmark (median-parse) kill answers
  // "how do you perform"; your latest kill answers "what are you wearing NOW". They're
  // usually the same, but diverge when your median-parse kill isn't your latest (often
  // a slightly different ilvl within the band) -- and then reading setup off the
  // benchmark made the prescription recommend a trinket the gear audit shows you
  // already wearing. Using bestKill keeps the prescription consistent with the audit.
  const current = (await soft("your current-gear kill", bestKill(name, server, region, difficulty)))
    || { code, fight, fightID: fight, startTime: 0 };
  const curCode = current.code || code;
  const curFight = current.fight != null ? current.fight : (current.fightID != null ? current.fightID : fight);
  const sameKill = curCode === code && curFight === fight;
  // Staleness of that SETUP snapshot (the current kill): if even your latest kill is
  // old, some enchant/gem/gear/consumable findings may already be done.
  const gearAgeDays = current.startTime ? Math.floor((Date.now() - current.startTime) / 86400000) : null;
  // Stat priority derived from what the field stacks -- never hard-coded. The
  // caller (app/CLI) already detected it; reuse it instead of re-sampling the
  // field's secondary stats (a whole peer fetch) again.
  const priority = knownPriority || await detectPriority(className, specName, difficulty, gearBoss.encounter.id);
  let you = null, my = null;
  try {
    you = await playerMetrics(code, fight, name, specName, className);            // benchmark kill: the DPS gap
    // Setup from your CURRENT kill (reuse the benchmark fetch when they're the same).
    const cm = sameKill ? you : await playerMetrics(curCode, curFight, name, specName, className);
    if (cm) my = await mySetup(curCode, curFight, cm.sourceID, cm.gear, priority, className);
    // HEALERS: enrich the benchmark metrics with per-ability overheal (the
    // sourceID-filtered Healing table -- reuses rotation's fetch) and mana over the
    // fight, so healingLevers can name your worst spill + read your mana. One extra
    // (mana) query, healer-only -- a damage run skips this entirely.
    if (runIsHealer() && you) {
      try { const hb = await healingBreakdown(code, fight, you.sourceID); you.overhealBy = hb.overhealBy; you.dmgBy = hb.effBy; } catch (e) { /* keep entry-level overheal% */ }
      try { you.mana = await manaStats(code, fight, you.sourceID); } catch (e) { /* no mana data */ }
    }
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
  // Analyze the rotation on the SAME (benchmark, median-parse) kill the gap is sized
  // on -- NOT bestKill. Otherwise the levers come from a kill where you played well
  // (small gaps) while the gap is measured on a median kill (huge), and the controllable
  // difference -- the wrong buttons you actually pressed that kill -- vanishes into the
  // residual. (Validated: a Feral read 12% castGap + no under-use on his best kill, but
  // 33% castGap + Ferocious Bite 3.2 vs 10.1/min on the benchmark kill.)
  const benchKill = (code && fight) ? { code, fight, encounter: gearBoss && gearBoss.encounter } : null;
  try { rot = await rotationFindings(name, server, region, className, specName, difficulty, benchKill); }
  catch (e) { skipped.push("rotation"); }
  try { tp = await topParseFindings(name, server, region, difficulty, className, specName); }
  catch (e) { skipped.push("top-parse comparison"); }
  try { tal = await talentFindings(name, server, region, className, specName, difficulty); }
  catch (e) { skipped.push("talents"); }
  // Size the BOSS-debuff comp levers (Chaos Brand / Mystic Touch) from the field too,
  // but only the ones you're actually MISSING (so we pay the per-peer Debuffs fetch
  // only when there's a lever to size -- usually none). Merges into field.compDeltas
  // so topParseLevers picks it up; a debuff the field is near-universal on still has
  // no split -> stays UNSIZED rather than guessed.
  // Skip the per-peer fetch on a healer run: Chaos Brand / Mystic Touch are
  // damage-TAKEN debuffs, so they can't size a healer's HPS (the delta would just
  // measure ~0) -- not worth the budget; the lever stays an unsized roster note.
  const missingBoss = (tp && tp.comp && !runIsHealer() ? tp.comp.missing : []).filter((e) => e.on === "boss");
  if (missingBoss.length && field) {
    const bd = await soft("boss-debuff comp", bossDebuffDeltas(name, server, region, gearBoss.encounter, difficulty, className, specName, missingBoss));
    if (bd) Object.assign(field.compDeltas = field.compDeltas || {}, bd);
  }

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
    ...gearLevers(gf, priority, field && field.statValue, field && field.gemDelta),
    ...(my ? statGapLever(gf, my, field, priority) : []),
    // Healer-specific efficiency levers (overhealing, mana) -- self-silent for a
    // damage run (runIsHealer false, overheal 0). Measured from your benchmark kill.
    ...healingLevers(you, field),
    ...rotationLevers(rot),
    ...talentLevers(tal),
    ...topParseLevers(tp, field && field.compDeltas),
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
