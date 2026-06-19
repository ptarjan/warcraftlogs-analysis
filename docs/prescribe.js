// @ts-check
// Generate a concrete, prioritized prescription. Ported from prescribe.py.
// prescribe folds every analysis's findings (the shared { dim, impact, label,
// text } currency from core) into ONE sorted change-list. Each domain owns its
// own lever-construction (gearLevers/rotationLevers/topParseLevers); prescribe
// adds the cross-cutting ones (execution, consumables, enchants, stat gap) that
// need its own peer aggregates, then sorts + splits + renders.
import {
  ENCHANTABLE_SLOTS, DIFFICULTY, characterZone, characterEncounter, playerMetrics,
  ilvlPeers, PEER_SAMPLE, BOSS_FANOUT, secondaryStats, buffUptimes, bossDebuffs, median, f, ordinal, detectPriority, mapLimit, collectUpTo, topEntry, bestRank, bestKill,
  KIND, DIM, fieldDelta, metricUnit, runIsHealer, runIsSupport, healingBreakdown, manaStats,
} from "./core.js";
import { timelineFindings } from "./timeline.js";
import { graphFindings, graphLevers } from "./graph.js";
import { gearFindings, gearLevers } from "./gear.js";
import { wclReport } from "./links.js";
import { rotationFindings, rotationLevers, mergeRotationRecurrence } from "./rotation.js";
import { talentFindings, talentLevers } from "./talents.js";
import { topParseFindings, topParseLevers, RAID_DAMAGE } from "./topparse.js";
import { healingLevers } from "./healing.js";
import { cacheOnly } from "./wcl.js";
// The percent-label / reconciliation / verdict / residual pure helpers live in
// prescribe-helpers.js (single source of truth -- the export-hygiene guard forbids
// re-exporting). Import the ones used here; tests import isOffMetaBuild from there.
import {
  pctLabel, reconcileImpacts, remainderKind, isEliteParse, strengths,
  verdictLever, verdictBlindSpots, overhaulDisclaimer, residualText, residualSummary, consumableHit, CONSUMABLES,
} from "./prescribe-helpers.js";
// The cross-cutting lever builders live in prescribe-levers.js (extracted to keep this
// module on fetch + reconcile + render). Import the ones run() assembles.
import {
  executionLevers, consumableLevers, enchantLevers, trinketLevers, statGapLever, ABOVE_FIELD_MARGIN,
} from "./prescribe-levers.js";

const SLOT_NAME = ENCHANTABLE_SLOTS;

async function bestIlvlKill(name, server, region, encounterId, difficulty, specName) {
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  const best = bestRank(er && er.ranks, specName);
  if (!best) return null;
  return [best.report.code, best.report.fightID, best.bracketData, best.startTime || 0, best.rankPercent, best.duration || 0];
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
  // Drop anomalously-SHORT kills before picking the median-parse one. On a much-shorter
  // -than-typical kill the field bursts disproportionately (all cooldowns up, no sustain),
  // so the raw-DPS gap is inflated and DIVERGES from the parse %ile -- a median-parse kill
  // that happens to be a 106s burst (vs your ~300s typical) reads "106% behind" while your
  // representative gap is ~80%. Drop only TRULY anomalous kills (< 40% of your median in-
  // band duration) so the blast radius is tiny; fall back to all in-band kills (no-op) if
  // that leaves too few, or if durations are missing.
  const durs = inBand.map((k) => k.dur || 0).filter((d) => d > 0);
  let pool = inBand;
  if (durs.length >= 3) {
    const medDur = median(durs);
    const normal = inBand.filter((k) => (k.dur || 0) >= medDur * 0.4);
    if (normal.length >= Math.ceil(inBand.length / 2)) pool = normal;
  }
  const sorted = [...pool].sort((a, b) => (a.rankPercent || 0) - (b.rankPercent || 0));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// Your parse HISTORY on the benchmark boss -- read from the per-kill ranks the
// kill-selection already fetched (characterEncounter is cached, so this is FREE: no
// new query, no budget hit). Two signals the single-kill deep-dive can't give:
//   - CONSISTENCY: the spread of your parses across all your kills of this boss. A
//     tight band means the one kill we analyzed is typical of how you play it; a wide
//     one means your play varies kill to kill (so don't over-read a single kill).
//   - IMPROVEMENT: are your RECENT kills parsing higher than your older ones? -- the
//     "have I gotten better / fixed something" signal, measured over time on the SAME
//     boss (parse percentile is comparable kill-to-kill). Pure -> testable.
// rankPercent is ilvl-normalized (a WCL percentile), so kills across gear are comparable.
export function killHistory(ranks, { minKills = 3, tight = 15, wide = 30, move = 8 } = {}) {
  const k = (ranks || [])
    .filter((r) => r && r.rankPercent != null && r.startTime)
    .map((r) => ({ p: r.rankPercent, t: r.startTime }))
    .sort((a, b) => a.t - b.t);
  if (k.length < minKills) return null;                  // too few kills to say anything
  const ps = k.map((x) => x.p);
  const lo = Math.round(Math.min(...ps)), hi = Math.round(Math.max(...ps));
  const third = Math.max(1, Math.floor(k.length / 3));
  const oldP = Math.round(median(k.slice(0, third).map((x) => x.p)));     // earliest third
  const newP = Math.round(median(k.slice(-third).map((x) => x.p)));       // most-recent third
  const delta = newP - oldP;
  return { n: k.length, lo, hi, spread: hi - lo, oldP, newP, delta,
    consistent: hi - lo <= tight, varies: hi - lo >= wide,
    trend: delta >= move ? "up" : delta <= -move ? "down" : "steady" };
}

// Your priority-stat as a % of your total secondary rating (crit/haste/mastery/vers).
const secPct = (s, priority) => 100 * s[priority] / (["crit", "haste", "mastery", "vers"].reduce((a, k) => a + s[k], 0) || 1);

// The ilvl-matched field, via the shared core.ilvlPeers (same set overview / timeline /
// rotation use -- one fetch shared, not a divergent copy). Stop once PEER_SAMPLE
// succeed; the candidate buffer only backfills failures. Per-peer reportCore + buff +
// stat fetches run concurrently, so gql() auto-batches them (no hand-bundling needed).
async function fetchPeerField(name, server, region, encounter, difficulty, className, specName) {
  const cands = await ilvlPeers(name, server, region, encounter, difficulty, className, specName);
  return collectUpTo(cands, PEER_SAMPLE, 5, async (r) => {
    const code = r.report.code, fight = r.report.fightID;
    const m = await playerMetrics(code, fight, r.name, specName, className);
    if (!m) return null;
    const bf = await buffUptimes(code, fight, m.sourceID);
    const s = await secondaryStats(code, fight, m.sourceID, className);
    return { m, bf, s };
  });
}

// Tally what the field RUNS: enchants per slot, trinkets (by item id -- a name can
// re-skin across ilvls; EFFECT-based so they get their own lever, never a stat-swap),
// the self-applied consumables (via the shared CONSUMABLES matchers), and each peer's
// priority-stat %. Pure over the fetched peers.
function tallyPeerField(peers, priority) {
  /** @type {Record<string, Map<string, number>>} */
  const enchBySlot = {};   // slot -> Map(name -> count)
  const trinkets = new Map(), flasks = new Map(), foods = new Map(), potions = new Map(), augRunes = new Map(), oils = new Map();
  const guids = new Map(); // consumable name -> spell guid (for Wowhead links)
  const byField = { flasks, foods, potions, augRunes, oils };
  const statPcts = [];
  for (const { m, bf, s } of peers) {
    for (const g of m.gear) {
      const slot = g.slot;
      if (slot in SLOT_NAME && g.permanentEnchantName) {
        const slotName = SLOT_NAME[slot];
        (enchBySlot[slotName] = enchBySlot[slotName] || new Map())
          .set(g.permanentEnchantName, (enchBySlot[slotName].get(g.permanentEnchantName) || 0) + 1);
      }
      if ((slot === 12 || slot === 13) && g.id) {
        const t = trinkets.get(g.id) || { name: g.name, count: 0 };
        t.count++; trinkets.set(g.id, t);
      }
    }
    for (const [nm, b] of Object.entries(bf)) {
      const lc = nm.toLowerCase();
      for (const c of CONSUMABLES) {
        if (!consumableHit(c, lc, b)) continue;
        const tally = byField[c.field];
        tally.set(nm, (tally.get(nm) || 0) + 1); guids.set(nm, b.guid);
      }
    }
    if (s) statPcts.push(secPct(s, priority));
  }
  return { enchBySlot, trinkets, flasks, foods, potions, augRunes, oils, guids, statPcts };
}

// Empirically VALUE each lever from the ilvl-matched sample -- median DPS of peers who
// have it vs who don't (fieldDelta), a measured FLOOR (confounded: good players do more
// of everything). null where the field gives no counterfactual (e.g. everyone flasks)
// -> the lever keeps its estimate. Covers: having ANY consumable (deltas), the FIELD'S
// TOP item for a wrong-choice swap (topDeltas), the priority stat by % (statDelta) and
// per RATING point (statValue, to size gear swaps from the field not a sim constant),
// the most-common gem (gemDelta), and self-buff raid amps (compDeltas; boss-side debuffs
// are measured separately in bossDebuffDeltas -- they sit on the enemy, not a peer's buffs).
function computeFieldDeltas(peers, dps, priority, tally) {
  const { flasks, foods, potions, augRunes, oils } = tally;
  const mask = (test) => peers.map((p) => Object.entries(p.bf || {}).some(([nm, b]) => test(nm.toLowerCase(), b)));
  /** @type {Record<string, FieldDelta|null>} */
  const deltas = {};
  for (const c of CONSUMABLES) deltas[c.field] = fieldDelta(dps, mask((lc, b) => consumableHit(c, lc, b)));
  const topMaskDelta = (counter, thr) => {
    if (!counter.size) return null;
    const topName = topEntry(counter)[0];
    return fieldDelta(dps, peers.map((p) => Object.entries(p.bf || {}).some(([nm, b]) => nm === topName && b.pct > thr)));
  };
  const topDeltas = {
    flasks: topMaskDelta(flasks, 50), foods: topMaskDelta(foods, 50),
    potions: topMaskDelta(potions, 0), augRunes: topMaskDelta(augRunes, 50), oils: topMaskDelta(oils, 50),
  };
  const withStat = peers.map((p, i) => ({ pc: p.s ? secPct(p.s, priority) : null, d: dps[i] })).filter((x) => x.pc != null && x.d > 0);
  let statDelta = null;
  if (withStat.length >= 8) {
    const medStat = median(withStat.map((x) => x.pc));
    statDelta = fieldDelta(withStat.map((x) => x.d), withStat.map((x) => x.pc >= medStat));
  }
  // Per-rating value: same ilvl, so more rating = an itemization choice, not more gear.
  // Split peers at the median priority RATING and price the DPS gap across the spread.
  const withRating = peers.map((p, i) => ({ r: p.s ? p.s[priority] : null, d: dps[i] })).filter((x) => x.r != null && x.d > 0);
  let statValue = null;
  if (withRating.length >= 8) {
    const medR = median(withRating.map((x) => x.r));
    const sd = fieldDelta(withRating.map((x) => x.d), withRating.map((x) => x.r >= medR));
    const spread = median(withRating.filter((x) => x.r >= medR).map((x) => x.r))
                 - median(withRating.filter((x) => x.r < medR).map((x) => x.r));
    if (sd && spread > 0) statValue = { pct: sd.pct, perRating: sd.pct / spread, nHave: sd.nHave, nNot: sd.nNot };
  }
  const gemTally = new Map();
  for (const { m } of peers) for (const g of (m.gear || [])) for (const gm of (g.gems || [])) if (gm.id) gemTally.set(gm.id, (gemTally.get(gm.id) || 0) + 1);
  let gemDelta = null;
  if (gemTally.size) {
    const topGem = topEntry(gemTally)[0];
    gemDelta = fieldDelta(dps, peers.map((p) => (p.m.gear || []).some((g) => (g.gems || []).some((gm) => gm.id === topGem))));
  }
  /** @type {Record<string, FieldDelta>} */
  const compDeltas = {};
  for (const e of RAID_DAMAGE) {
    if (e.on !== "self") continue;
    const d = fieldDelta(dps, peers.map((p) => Object.entries(p.bf || {}).some(([nm, b]) => e.match.test(nm) && b.pct > 1)));
    if (d) compDeltas[e.key] = d;
  }
  return { deltas, topDeltas, statDelta, statValue, gemDelta, compDeltas };
}

// The field's gear/consumable/stat picture for prescribe: fetch the peers once, tally
// what they run, and value each lever from the sample. (Split into fetch/tally/value so
// each piece reads + tests on its own; the assembled shape is unchanged.)
/** @returns {Promise<PeerField>} */
async function fieldGearConsumables(name, server, region, encounter, difficulty, className, specName, priority = "crit") {
  const peers = await fetchPeerField(name, server, region, encounter, difficulty, className, specName);
  const tally = tallyPeerField(peers, priority);
  const dps = peers.map((p) => p.m.dps);
  const fieldD = computeFieldDeltas(peers, dps, priority, tally);
  const { enchBySlot, trinkets, flasks, foods, potions, augRunes, oils, guids, statPcts } = tally;
  return {
    enchBySlot, trinkets, flasks, foods, potions, augRunes, oils, guids,
    ...fieldD,
    statPct: statPcts.length ? median(statPcts) : null, n: peers.length,
    dpsMed: peers.length ? median(dps) : null, // measured field DPS
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
  // Which consumable buff you ran, keyed by its `mine` name (flask/food/potion/...),
  // via the shared CONSUMABLES matchers -- same detection as the field tally.
  const mine = {};
  for (const c of CONSUMABLES) mine[c.mine] = Object.entries(bf).find(([n, b]) => consumableHit(c, n.toLowerCase(), b));
  const { flask, food, potion, augrune, oil } = mine;
  const stats = await secondaryStats(code, fight, sourceId, className);
  const statPct = stats ? secPct(stats, priority) : null;
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
  // Fan the bosses out -- independent peer-fetch waves, coalesced by the gql() batcher
  // -- instead of one-at-a-time. mapLimit returns in order; perBoss content is identical.
  const perBoss = (await mapLimit(bosses, BOSS_FANOUT, async (r) => {
    try { return await timelineFindings(name, server, region, r.encounter, difficulty, className, specName); }
    catch (e) { return null; }
  })).filter(Boolean);
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

// Consumables you apply yourself -- ONE source of truth: how to detect each from a
// buff-uptime table (`match` on the lowercased name + `minPct` uptime floor -- potions
// are brief, so any uptime counts) AND how to render its lever (label/verb/sizes). This
// table drove the lever rows; it now also drives detection, replacing three copied
// matcher blocks (field tally, fieldDelta mask, mySetup). `field` keys the peer tallies.
// A flask/food/potion/oil/rune can't plausibly give more than a few % DPS. A measured

// --- renderPrescription, split into its three sections. Each takes the assembled
//     prescription data `d` and logs; pure presentation -- the analysis already happened. ---

// Header: where you parse, partial/staleness NOTEs, the measured gap vs the field, and the
// kill-to-kill consistency/trend line.
function renderHeader(log, d, you, field, peerGap, topGap) {
  const k = (n) => `${f((n || 0) / 1000, 1)}k`;
  // No title line here -- the report hero (name · realm · region + spec/difficulty
  // pills) and the card's own "What to change" header already say who this is.
  // Quoted kills link straight to your Warcraft Logs report+fight.
  const bestBoss = d.topReport
    ? wclReport(d.topReport.code, d.topReport.fight, d.topParse.encounter.name) : d.topParse.encounter.name;
  const gearBossLink = wclReport(d.code, d.fight, d.gearBoss.encounter.name);
  if (d.medP != null) log(`You parse ${ordinal(d.medP)} percentile on ${d.difficultyName} (median of the ${d.nBosses} current-tier ${d.difficultyName} boss${d.nBosses === 1 ? "" : "es"} you've killed; best ${ordinal(d.bestP)} on ${bestBoss}).`);
  if (d.skipped && d.skipped.length) {
    // Name the REAL cause. On a cache-only CLI run an uncached section throws CacheMiss
    // (we didn't fetch) -- calling that "the WCL rate limit" sent me chasing a budget
    // problem that didn't exist. Only when we ARE fetching (the browser, or --allow-fetch)
    // is a skip actually a throttle / private log. cacheOnly() distinguishes them.
    const why = cacheOnly()
      ? "not in the local cache and this run didn't fetch (cache-only) -- re-run with --allow-fetch to pull it"
      : "likely the WCL rate limit, or a private log";
    log(`NOTE: partial list -- couldn't load ${d.skipped.join(", ")} (${why}). This isn't the full picture; re-run for the rest.`);
  }
  // Staleness: gear/enchant/gem/consumable findings are read off your most recent
  // kill. If that's not actually recent, the setup findings may already be fixed.
  if (d.gearAgeDays != null && d.gearAgeDays >= 7) {
    log(`NOTE: your most recent ${d.difficultyName} kill is ~${d.gearAgeDays} days old (ilvl ${d.curIlvl}). The enchant/gem/gear/consumable findings reflect THAT kill -- if you've enchanted/re-gemmed/upgraded since, some are already done. Re-run after a fresh kill for an accurate setup check.`);
  }
  if (peerGap == null) return;
  const ahead = peerGap <= 0;
  const gapPhrase = ahead ? `${Math.abs(peerGap)}% ahead` : `${peerGap}% behind`;
  const topClause = topGap != null ? `, and ${topGap}% behind the top parses` : "";
  // Is the gap mostly a damage-bound REMAINDER (the healer "it's the encounter" framing
  // holds) or mostly CONCRETE fixes? When your own sized levers already explain most of the
  // gap, "most of it is the encounter/comp" CONTRADICTS the "~Npp you can fix" breakdown
  // below (Mostlynotgay: 13% behind, all of it haste/embellishment/enchant/cooldown). Use
  // the same finding impacts the breakdown reconciles, so header and breakdown agree.
  const yoursSum = (d.rx || []).filter((r) => r.impact > 0 && r.dim !== DIM.COMP).reduce((s, r) => s + (r.impact || 0), 0);
  const mostlyFixable = !ahead && peerGap > 0 && yoursSum >= peerGap * 0.5;
  // What the gap MEANS, as its own sentence (not a dashed aside): same-gear players
  // already do it, so it's gainable, and the list below is sized to sum to it.
  const tail = ahead
    ? ` You're already beating your item-level bracket -- the top parses are the target now.`
    : isEliteParse(d.medP)
    ? ` But the field here is the TOP parses at your item level, and at your ${ordinal(d.medP)} percentile most of that gap is raid comp + execution on optimal pulls, not a setup you're getting wrong. The fixes below are the concrete part you control.`
    : runIsHealer()
    ? (mostlyFixable
       ? ` Most of that gap is concrete -- the gear/enchant/cooldown fixes below. (${metricUnit()} is also capped by the damage your raid takes, so chase effective throughput, not raw ${metricUnit()}.)`
       : ` But ${metricUnit()} is capped by the damage your raid takes and your healing assignment, so most of that gap is the encounter and healer comp, not ${metricUnit()} you can simply add. The fixes below are the concrete part you control.`)
    : runIsSupport()
    ? ` But as a support, most of your value is the amps you keep on allies (credited to THEIR parses, not your personal DPS), so this personal-DPS gap mostly measures buff value, not DPS you can simply add. Your real lever is buff uptime (see the Support buffs card); the fixes below are the rest you control.`
    : ` They're at your exact item level, so that ${peerGap}% is realistically yours to gain -- the fixes below are sized to add up to it.`;
  log(`Measured on ${gearBossLink} (ilvl ~${d.curIlvl}): you do ${k(you.dps)} ${metricUnit()} vs the ilvl-matched field's ${k(field.dpsMed)} -- ${gapPhrase}${topClause}.${tail}`);
  // CONSISTENCY + IMPROVEMENT, from your most-farmed boss's parse history (FREE --
  // cached ranks): are you steady or all over the place kill-to-kill, and are your
  // recent kills better than your older ones? The single-kill deep-dive can't see
  // either. Same boss across time, so it's a clean signal (parse %ile is normalized).
  const h = d.hist;
  if (h) {
    // Make the spread + trend ONE coherent story: a wide range under a rising trend
    // is the CLIMB (improvement), not kill-to-kill inconsistency -- only a wide spread
    // with NO trend is genuine variance. Don't say "you vary a lot" AND "you're improving".
    let msg = `Consistency: across your ${h.n} ${d.histBoss} kills you've parsed ${h.lo}-${h.hi}%ile`;
    if (h.trend === "up")
      msg += ` and you're trending UP -- recent kills (~${ordinal(h.newP)}) beat your earlier ones (~${ordinal(h.oldP)}). The range is mostly that climb; whatever you changed, keep it.`;
    else if (h.trend === "down")
      msg += ` and trending DOWN -- recent kills (~${ordinal(h.newP)}) sit below your earlier ones (~${ordinal(h.oldP)}); worth a look at what changed.`;
    else if (h.consistent)
      msg += ` -- a tight band, so you play it about the same every time (the deep-dive above is typical).`;
    else if (h.varies)
      msg += ` at a steady average -- a wide spread with no clear trend means your play varies kill to kill, so a single kill isn't your ceiling.`;
    else msg += ` -- a normal spread.`;
    log(msg);
  }
}

// Raid COMP alone accounts for your WHOLE measured gap -> every one of your own levers
// reconciles to ~0, so the verdict names comp (a roster ask) instead of headlining a <1%
// lever that contradicts the "~0pp you can fix" breakdown. Pure -> testable. (compImpact >=
// peerGap > 0 already implies a comp finding exists, so no separate length check needed.)
export const compCoversGap = (peerGap, compImpact) => peerGap != null && peerGap > 0 && compImpact >= peerGap;

// A blunt, character-specific VERDICT: name the situation so the report never reads like a
// template -- and always points at an action (respec / the few setup fixes / "tighten your
// play, there's no shortcut"). `yours` is the actionable findings, sorted biggest-first.
function renderVerdict(log, d, yours) {
  const compList0 = d.rx.filter((r) => r.dim === DIM.COMP);
  const setupFixes = yours.filter((r) => r.dim === DIM.GEAR || r.dim === DIM.SETUP);
  // Any talent/build change -- whether a never-pressed talented ability or a meta
  // talent the field runs and you don't. Both carry KIND.TALENTS (a build swap, same
  // VERDICT); the hero-tree swap carries KIND.HERO_TREE.
  const hasBuild = yours.some((r) => r.kind === KIND.TALENTS || r.kind === KIND.HERO_TREE);
  // A talent/build swap is dim "Rotation"; tell the play-lever version apart by kind so
  // the verbs ("respec" vs "play differently") never mismatch.
  const rotKindOf = (r) => r.kind === KIND.EMPOWERMENT ? "an EMPOWERMENT timing fix (landing your hardest hit in its high-damage window)"
    : r.kind === KIND.COOLDOWN ? "a COOLDOWN you under-use"
    // WEAK_WINDOW is dim Rotation but it's an UPTIME/execution gap, not pressing the wrong
    // button -- calling it "a ROTATION/priority fix" misreads it (Stonestorm: his only
    // "rotation" lever is his damage cratering in one phase, with ✓ PRIORITY standing).
    : r.kind === KIND.WEAK_WINDOW ? "keeping your damage up through the one phase where it craters (see the DAMAGE TIMELINE item)"
    : r.kind === KIND.OVERHEAL ? "healing SMARTER -- cutting your overhealing (output landing on already-full health bars)"
    : "a ROTATION/priority fix";
  // The VERDICT must name the ACTUAL biggest character lever. `yours` is sorted by
  // impact desc (rx.sort, comp + the playstyle remainder excluded), so yours[0] IS
  // it. Keying off a fixed category precedence (build > rotation > setup) was the
  // bug: a 3% talent swap got announced as "your biggest lever -- sort that first"
  // over an 8% rotation fix, contradicting the biggest-first list right above it.
  const lever = verdictLever(yours);
  // When raid COMP alone accounts for your whole measured gap, reconcile scales every one
  // of your own levers to ~0 -- so headlining a <1% rotation tweak as "your biggest lever"
  // both contradicts the "~0pp you can fix" breakdown right below AND deflates a player who
  // is actually matching the field. Name the comp instead: it's a roster ask, not a fix you
  // make to your character. (Luvalot: 83rd %ile, 7% behind, all of it Power Infusion + Aug.)
  const peerGap = (d.you && d.you.dps && d.field && d.field.dpsMed)
    ? Math.round(((d.field.dpsMed - d.you.dps) / d.you.dps) * 100) : null;
  const compImpact = compList0.reduce((s, r) => s + (r.impact || 0), 0);
  if (compCoversGap(peerGap, compImpact)) {
    log(`VERDICT: on your own character you're already matching the field at your item level -- every fix below is under ~1%. Your ${peerGap}% gap is raid COMP (the buffs in the comp list below): a roster ask your group fills, not something you change on your character.`);
    return;
  }
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
    log(`VERDICT: your biggest character lever is ${rotKindOf(yours[0])}${thenExtra}. The gap is mostly HOW you play the same gear${overhaulDisclaimer("setup", d.skipped)}${compList0.length ? " (comp aside)" : ""}.`);
  } else if (lever === "execution") {
    // Name the SPECIFIC execution issue: a movement/range lever is NOT "uptime / pressing
    // on time" -- saying that contradicts the "~100% active, barely idling" strength a
    // movement-bound player (e.g. a Disc Priest at 9.3s/min of movement) earns.
    const execWhat = yours[0] && yours[0].kind === KIND.MOVEMENT
      ? "EXECUTION (cutting avoidable movement -- staying in range to cast)"
      : "EXECUTION (uptime / pressing on time)";
    log(`VERDICT: your biggest character lever is ${execWhat}${thenExtra}. The gap is HOW you play${overhaulDisclaimer("setup", d.skipped)}${compList0.length ? " (comp aside)" : ""}.`);
  } else if (lever === "setup") {
    // Only credit "pressing faster" when a press-faster lever survived -- for a
    // player who already out-casts the field it's suppressed, and the gap is
    // damage-per-cast (the gear/setup fixes), not activity.
    const hasPress = yours.some((r) => r.kind === KIND.PRESS_FASTER);
    const buildNote = hasBuild ? " (plus a talent swap)" : "";
    // Metric-aware: a healer's residual gap is healing efficiency + damage-bound
    // throughput, never "damage-per-cast". (Same class of fix as the HPS metric-word
    // routing; "damage-per-cast" would leak a damage word into an HPS report.)
    const residualWord = hasPress ? "more pulls" : runIsHealer()
      ? "healing efficiency + throughput (stats/gear/comp), not activity"
      : "damage-per-cast (stats/gear), not activity";
    // Don't reassure "not a rotation overhaul" when a rotation habit recurs across your
    // OTHER bosses (hidden on the benchmark) -- point at it instead, or it reads as the
    // verdict dismissing the HABIT ACROSS FIGHTS note (Silvercircle: gear-led, yet he
    // under-presses Hand of Gul'dan on 2/3 of his bosses).
    const rotTail = d.rotHabitAcrossFights
      ? " -- though you have a rotation habit that recurs across your other fights (see HABIT ACROSS FIGHTS)"
      : overhaulDisclaimer("rotation", d.skipped);
    log(`VERDICT: your biggest character levers are the ${setupFixes.length} gear/setup fix${setupFixes.length > 1 ? "es" : ""} below${buildNote}${hasPress ? " + pressing faster" : ""}. The big gap is ${compList0.length ? "comp + " : ""}${residualWord}${rotTail}.`);
  } else {
    // "Nothing to fix" must NOT be claimed over sections we never loaded. An empty
    // actionable list is MORE likely under a partial run (a skipped rotation/talents/gear
    // contributes no levers), so a verdict-relevant skip turns "it all matches the field"
    // into a false all-clear that contradicts the partial-data NOTE above. Say "we couldn't
    // check" instead, and name exactly what's missing.
    const blind = verdictBlindSpots(d.skipped);
    if (blind.length) {
      log(`VERDICT: nothing actionable in what we COULD load -- but we couldn't load ${blind.join(", ")} (see the NOTE above), so this is NOT a complete check. Re-run when the budget resets before concluding there's nothing to fix.`);
    } else {
      log(`VERDICT: build, gear, enchants, and rotation all match the field -- there's NO setup or talent fix to make. Your gap is ${compList0.length ? "comp + " : ""}execution (press faster / uptime). Tighten your play; there's no gear/talent shortcut.`);
    }
  }
}

// The change-list: reconcile the levers to the measured gap, split yours / raid-comp /
// info, render each line, then close on the strengths (what you're doing well).
function renderChangeList(log, d, peerGap, outpaces) {
  const { rx, execd, rot } = d;
  const isComp = (r) => r.dim === DIM.COMP;
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
  let residualKind = null;
  if (gap > 0 && residual >= 1) {
    const r = Math.round(residual);
    // PRECEDENCE BY SIZE FIRST. A big remainder is the analysis admitting it can't
    // explain the gap -- it must NEVER be relabeled "press faster" (you can't
    // attribute 17% to a press-faster lever that's worth 4%). Only a small remainder
    // with a real cast deficit is credibly "press a bit faster".
    // A ~99%-active player (or one who out-casts the field) is NOT idling -- their cast
    // deficit is ability MIX (harder-hitting / defensive GCDs), not press-faster. Framing
    // their remainder as "GCD uptime / press on more pulls" contradicts their own ✓ UPTIME
    // (and the press-faster lever, suppressed by the same >=98 bar). At/above that bar the
    // remainder is per-cast (stats/variance), so let it fall through to "small". (Andaarius:
    // 94th %ile, ~99% active, was told the gap is "GCD uptime" next to "barely idling".)
    const activePct = (execd && execd.activePct != null) ? execd.activePct : (d.you && d.you.activePct);
    const noIdle = (activePct != null && activePct >= 98) || outpaces;
    const underPress = !noIdle && ((rot && rot.castGap && rot.castGap.field > rot.castGap.you)
      || (execd && execd.pressExcess >= 1));
    residualKind = remainderKind(residual, { elite: isEliteParse(d.medP), healer: runIsHealer(), support: runIsSupport(), underPress });
    const rtext = residualText(residualKind, r, d, rot, rx);
    renderYou.push({ dim: DIM.EXECUTION, impact: residual, label: pctLabel(residual), text: rtext, basis: "measured" });
  }
  // Sort AFTER the remainder is pushed so the list stays biggest-first INCLUDING it: a
  // large unexplained remainder is the biggest lever and must lead, not hide under a 1%
  // gear swap (the hard rule -- the order must match the displayed % DPS). INFO notes
  // (impact 0) always trail.
  if (gap > 0) renderYou.sort((a, b) => b.impact - a.impact);
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
        (residual >= 1 ? ` · ~${Math.round(residual)}pp ${residualSummary(residualKind)}` : "") + ".");
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
  // Close on the positives: the checks you PASSED (silent levers = you're at/above the
  // field). So the report isn't all problems, and you can see what to KEEP doing.
  const wins = strengths(d);
  if (wins.length) {
    log("");
    log("--- What you're doing well (keep it) ---");
    for (const w of wins) log(`  ✓ ${w}`);
  }
  log("");
}

// THE synthesis, rendered: one answer anchored on the MEASURED gap. Computes the few
// cross-section locals, then delegates to the three section renderers. Pure presentation.
function renderPrescription(log, d) {
  const { rx, you, field, tp, rot } = d;
  const peerGap = (you && you.dps && field && field.dpsMed) ? Math.round(((field.dpsMed - you.dps) / you.dps) * 100) : null;
  const topGap = (tp && tp.dpsGapPct) ? Math.round(tp.dpsGapPct) : null;
  // You out-cast the field -> the "GCD uptime lost" heuristic is contradicted; the
  // residual framing (renderChangeList) uses this to call the gap damage-per-cast.
  const outpaces = rot && rot.castGap && rot.castGap.field > 0 && rot.castGap.you >= rot.castGap.field;
  const yours = rx.filter((r) => r.impact > 0 && r.dim !== DIM.COMP);  // actionable, sorted biggest-first
  renderHeader(log, d, you, field, peerGap, topGap);
  renderVerdict(log, d, yours);
  // (No "what the gap is made of" summary -- the verdict names the situation and the
  // numbered list below IS the breakdown, sorted biggest-first. Restating it read as dup.)
  log(`(Field = top-ranked players at your item level; top parses = the rank-1 kills.)`);
  renderChangeList(log, d, peerGap, outpaces);
}

/** @param {string|null} [knownPriority] */
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
    const bk = await bestIlvlKill(name, server, region, r.encounter.id, difficulty, specName);
    if (bk) kills.push({ ilvl: bk[2] || 0, boss: r, code: bk[0], fight: bk[1], startTime: bk[3] || 0, rankPercent: bk[4], dur: bk[5] || 0 });
  }
  // `ranks` is filtered on kills+rankPercent, NOT spec -- a flexer detected as a spec
  // they didn't play these bosses on yields no per-spec kills, so `kills` is empty and
  // pickBenchmarkKill returns null. Fail with a clean message, not a TypeError on the payoff.
  const bench = pickBenchmarkKill(kills);
  if (!bench) throw new Error(`No ${specName} kills found.`);
  const { ilvl: curIlvl, boss: gearBoss, code, fight } = bench;
  // Parse HISTORY for the consistency + improvement signals -- read from your MOST-
  // FARMED boss (the most kills = the most data, and a clean same-boss trend), which
  // is often a different boss than the benchmark (a late boss you've killed once).
  // FREE: characterEncounter for every boss was already fetched by bestIlvlKill above,
  // so this read is cached -- no new query, no budget hit.
  const farmedBoss = ranks.reduce((a, b) => ((b.totalKills || 0) > (a.totalKills || 0) ? b : a));
  const farmedEnc = await characterEncounter(name, server, region, farmedBoss.encounter.id, difficulty).catch(() => null);
  const hist = killHistory(farmedEnc && farmedEnc.ranks);
  const histBoss = farmedBoss.encounter.name;
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
    gearFindings(name, server, region, className, specName, difficulty, priority));
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
  // Up to 2 OTHER recent current-gear kills of the benchmark boss, so rotationFindings can
  // MEDIAN the cast rate across kills -- the under-press / press-faster lever then reflects
  // how you typically play it, not one pull's button-spam noise. FREE list: characterEncounter
  // for this boss is already cached (bestIlvlKill fetched it); only re-analyzing the extra
  // kills costs (a few report reads), and it degrades to benchmark-only if they don't load.
  let recentKills = [];
  try {
    const be = gearBoss && await characterEncounter(name, server, region, gearBoss.encounter.id, difficulty);
    const rk = (be && be.ranks) || [];
    if (rk.length > 1) {
      const maxIl = Math.max(...rk.map((r) => r.bracketData || 0));
      recentKills = rk
        .filter((r) => r.report && (r.report.code !== code || r.report.fightID !== fight))   // not the benchmark kill
        .filter((r) => (r.bracketData || 0) >= maxIl - 1)                                     // current-gear band
        .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))                              // most recent first
        .slice(0, 2)
        .map((r) => ({ code: r.report.code, fight: r.report.fightID }));
    }
  } catch (e) { /* aggregation is a bonus -- benchmark-only on any failure */ }
  try { rot = await rotationFindings(name, server, region, className, specName, difficulty, benchKill, recentKills); }
  catch (e) { skipped.push("rotation"); }
  // CROSS-BOSS: analyze your rotation on up to 2 OTHER recent bosses (each vs ITS OWN
  // field) so the prescription can tell a CONSISTENT habit from a one-fight artifact --
  // the "teach me over all my playing, not one kill" axis. A lever that recurs across
  // bosses is a confirmed habit to prioritize; one that only shows on the benchmark kill
  // may be fight-specific. We reuse the per-boss representative kill already in `kills`
  // (bestIlvlKill -- no new ranking fetch); only re-analyzing the OTHER bosses costs (~1
  // report read each, the peer field). Bounded to 2 and fully fail-soft: any boss that
  // doesn't load just doesn't contribute recurrence, and the benchmark levers stand alone.
  const otherRot = [];
  const otherBossKills = kills
    .filter((k) => k.boss.encounter.id !== gearBoss.encounter.id)   // a DIFFERENT boss
    .filter((k) => (k.ilvl || 0) >= curIlvl - 1)                    // current-gear band
    .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))        // most recent first
    .slice(0, 2);
  // SILENT degrade (NOT soft()): recurrence is a bonus on top of a complete prescription,
  // so a throttled cross-boss read must NOT push to `skipped` -- that would mislabel the
  // core list as "partial / not the full picture". Any boss that doesn't load just drops
  // its recurrence vote; the benchmark levers stand exactly as before.
  for (const k of otherBossKills) {
    try {
      const ro = await rotationFindings(name, server, region, className, specName, difficulty,
        { code: k.code, fight: k.fight, encounter: k.boss.encounter }, []);
      if (ro) otherRot.push({ name: k.boss.encounter.name, findings: ro });
    } catch (e) { /* bonus only -- benchmark levers stand alone */ }
  }
  try { tp = await topParseFindings(name, server, region, difficulty, className, specName); }
  catch (e) { skipped.push("top-parse comparison"); }
  try { tal = await talentFindings(name, server, region, className, specName, difficulty); }
  catch (e) { skipped.push("talents"); }
  // DPS-over-time: WHERE in the fight you leak vs the phase-aligned field, diagnosed
  // (idle vs cooldowns spent elsewhere). Feeds the list -- a cooldown-misalignment dip
  // is DPS the cast/uptime aggregates miss (it's about WHEN you press, not whether);
  // an idle dip becomes an INFO that LOCATES the lost-GCD time (no double-count). Cached
  // after the DPS-over-time card ran, so this re-computes over warm fetches.
  const graphData = await soft("dps-over-time", graphFindings(name, server, region, className, specName, difficulty));
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
  // Do you ALREADY run more of the priority stat than the field (good players at your
  // ilvl)? If your aggregate share beats theirs by a clear margin, you're past the point
  // where "stack more" is a lever -- suppress the over-stacking recrafts (gearLevers) and
  // let the "well itemized" strength stand instead of contradicting it. (Rammrod/Fury:
  // 54% haste vs the field's 37% -- recrafting for +177 more haste was the wrong advice.)
  const aboveField = (my && my.statPct != null && field && field.statPct != null)
    && my.statPct >= field.statPct + ABOVE_FIELD_MARGIN;
  // Your OUTPUT already beats the field median (peerGapPct < 0 = ahead). Distinct from
  // aboveField (which is the priority STAT): an ahead player has little real gear to add, so
  // the confounded field-delta levers get a tighter cap (GEAR_LEVER_CAP_AHEAD). 5pp margin so
  // a roughly-even player keeps the normal sizing.
  const outputAhead = peerGapPct != null && peerGapPct <= -5;
  // Cross-boss recurrence: the benchmark levers carry the (gap-sized) impact; a habit that
  // recurs on your other recent bosses gets annotated, and a habit that recurs ONLY on them
  // becomes an INFO note (impact 0, so the gap reconciliation -- sized on the benchmark kill
  // -- is untouched). Degrades to the plain benchmark levers when no other boss loaded.
  const rotMerged = mergeRotationRecurrence(
    rotationLevers(rot),
    otherRot.map((o) => ({ name: o.name, levers: rotationLevers(o.findings) })));
  // The rotation's own-baseline WEAK_WINDOW (where you trail YOUR typical) and the
  // graph's field-relative PHASE_DIP often catch the SAME late slump -- two ~equal items
  // about one stretch reads as padding. When their fight-fraction windows overlap, keep
  // the ONE that says more: the graph dip when it diagnosed a cooldown problem (cast rate
  // normal -> WHEN you press, which the weak window can't tell); otherwise the weak window
  // (and drop the graph's now-redundant idle locator).
  let rotLevers = rotMerged.levers, gLevers = graphLevers(graphData);
  const dip = graphData && /** @type {any} */ (graphData).worst, ww = rot && rot.weakWindow;
  if (dip && ww && dip.fracStart != null && gLevers.some((l) => l.kind === KIND.PHASE_DIP)) {
    const inter = Math.max(0, Math.min(dip.fracEnd, ww.to) - Math.max(dip.fracStart, ww.from));
    const minW = Math.min(dip.fracEnd - dip.fracStart, ww.to - ww.from) || 1;
    if (inter / minW >= 0.5) {
      if (dip.cause === "cooldown") rotLevers = rotLevers.filter((l) => l.kind !== KIND.WEAK_WINDOW);
      else gLevers = gLevers.filter((l) => l.kind !== KIND.PHASE_DIP);
    }
  }
  /** @type {Finding[]} */
  const rx = [
    ...executionLevers(execd, rot, peerGapPct, (execd && execd.activePct != null) ? execd.activePct : (you && you.activePct)),
    ...(field && my ? consumableLevers(field, my) : []),
    ...(field && my ? enchantLevers(field, my) : []),
    ...trinketRx,
    ...gearLevers(gf, priority, field && field.statValue, field && field.gemDelta, aboveField, outputAhead),
    ...(my ? statGapLever(gf, my, field, priority) : []),
    // Healer-specific efficiency levers (overhealing, mana) -- self-silent for a
    // damage run (runIsHealer false, overheal 0). Measured from your benchmark kill.
    ...healingLevers(you, field),
    ...rotLevers,
    ...rotMerged.infos,
    ...gLevers,
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
    medP, bestP, topParse, nBosses: ranks.length, gearAgeDays, hist, histBoss,
    you, field, execd, rot, tp, gf, my, priority, rx, skipped, aboveField,
    recurKinds: rotMerged.recurringKinds,
    // A rotation habit that recurs on your OTHER bosses but was HIDDEN on the benchmark
    // kill (an INFO "HABIT ACROSS FIGHTS" note). The verdict uses this so a setup-led
    // "not a rotation overhaul" never dismisses a habit we just flagged across your raid.
    rotHabitAcrossFights: rotMerged.infos.length > 0,
  });
}
