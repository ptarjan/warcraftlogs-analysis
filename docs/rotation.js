// @ts-check
// Rotation analysis -- CLASS-AGNOSTIC. Works for any spec because it hard-codes
// no ability names or priorities (the bug before: assuming Tiger Palm was a
// filler when an empowered Tiger Palm is actually the biggest hit). Everything
// is derived from the data and compared to the field:
//   - which of YOUR abilities hits hardest (per-hit), for any class
//   - "empowered" hits: abilities with a high cluster of outsized hits (procs);
//     how often you land them vs the field
//   - your opener sequence vs the field's
import {
  playerMetrics, ilvlPeers, mapLimit, median, bestKill, reportDeaths,
  playerAbilities, dotUptimes, petDamage, fightWindow, fightEvents, paginateEvents, buffUptimes, f, DPS, INFO, finding, KIND, DIM, eventTable, runIsHealer, runIsSupport, throughputWord,
  damageAbilitiesForced, alwaysAtonement, atonementIfDamaging, isAtonement,
} from "./core.js";
import { talentedAbilities, heroTreeOf } from "./talents.js";
import { wowheadSpell } from "./links.js";
import { spellTooltip } from "./wcl.js";
// The pure, unit-tested helpers now live in rotation-helpers.js (single source of
// truth -- the export-hygiene guard forbids re-exporting them). Import the ones this
// module uses internally; tests and prescribe.js import the rest from there directly.
import {
  empoweredCount, openerSequence, consensusOpener, openerDivergence, majorCooldownIds,
  cooldownStackFraction, cooldownStackGap, cooldownUseComparable, empoweredStats,
  empowermentCandidate, damageCurve, weakestWindow, fieldCastRates, medianCastRates,
  usageDivergence, sameHeroPeers, realOveruse, perCastValue, dmgGapPct,
  cooldownGaps, usageDamageGaps, castUsageGaps, selfBuffMatch, buffWindowUplift,
  buffCdGap, perCastGaps, dotUptimeGaps, petShareGap, classifyUnderUse, castable,
} from "./rotation-helpers.js";

// --- data layer: everything reads from the shared core loader (reportCore,
// fightWindow, fightEvents, paginateEvents) so a kill's tables/events are fetched
// once across rotation, diagnose, and analyze. -------------------------------

// One player's damage abilities (guid/name/total), highest total first. Uses the
// sourceID-FILTERED table (core.playerAbilities), NOT the shared unfiltered one --
// the latter truncates to ~5 abilities/actor, which for a caster drops the core
// casts and makes the cast rate / rotation comparison undercount badly.
async function damageAbilities(code, fight, sourceId) {
  return playerAbilities(code, fight, sourceId);
}

// Per-hit stats from raw damage events. Separates crit-driven big hits (a stat
// outcome, not rotation) from genuine empowerment procs (non-crit outsized hits),
// so we never tell someone to "use a proc" when they just need crit.
function perHit(events) {
  const amounts = events.map((x) => x.amount || 0);
  const s = [...amounts].sort((a, b) => a - b);
  const crits = events.filter((x) => x.hitType === 2).length;
  const nonCrit = events.filter((x) => x.hitType !== 2).map((x) => x.amount || 0);
  const empSt = empoweredStats(nonCrit);
  return {
    count: s.length,
    med: s.length ? s[Math.floor(s.length / 2)] : 0,
    max: s.length ? s[s.length - 1] : 0,
    critPct: s.length ? (100 * crits) / s.length : 0,
    procBig: empoweredCount(nonCrit),         // outsized NON-crit hits = a real proc
    empShare: empSt ? empSt.share : null,     // fraction of casts that land empowered (null if too few)
    empCount: empSt ? empSt.empowered : null, // and the concrete counts behind that fraction
    empN: empSt ? empSt.total : null,
  };
}

// Analyze one kill. `topN` damage abilities get per-hit detail (you); peers pass
// `onlyAbility` (a name) to measure just that ability's empowered rate.
async function analyzeKill(name, code, fight, specName, className, opts = {}) {
  const m = await playerMetrics(code, fight, name, specName, className);
  if (!m) return null;
  const [s, e] = await fightWindow(code, fight);
  const dur = (e - s) / 1000;

  // Opener from cast events (names via the damage-ability map is enough here).
  const abils = await damageAbilities(code, fight, m.sourceID);
  const id2name = Object.fromEntries(abils.map((a) => [a.guid, a.name]));
  const name2id = Object.fromEntries(abils.map((a) => [a.name, a.guid]));
  const rawCasts = (await fightEvents(code, fight, m.sourceID, s, e)).casts.filter((x) => !x.fake);
  const cpm = dur ? 60 / dur : 0;
  // ALL casts/min keyed by ability id -- the damage table is truncated to ~5
  // abilities, so buff/pet COOLDOWNS (Invoke Niuzao, Weapons of Order) appear ONLY
  // here, not in the damage-derived castRate. Names are resolved later (via Wowhead)
  // for just the few that diverge from the field, so this stays cheap.
  const allCastRate = {};
  for (const x of rawCasts) allCastRate[x.abilityGameID] = (allCastRate[x.abilityGameID] || 0) + 1;
  for (const k of Object.keys(allCastRate)) allCastRate[k] *= cpm;
  // Fight-relative cast timestamps per ability id -- so the buff-cooldown lever can size
  // the damage uplift in the window after each under-pressed buff WITHOUT re-fetching
  // casts (they're already here), and the CD-ALIGNMENT diagnostic can measure how stacked
  // your (and each peer's) major cooldowns are. Returned on both the you + onlyAbility paths.
  const castTimesById = {};
  for (const x of rawCasts) (castTimesById[x.abilityGameID] ||= []).push(x.timestamp - s);

  const casts = rawCasts
    .filter((x) => id2name[x.abilityGameID])
    .map((x) => ({ t: x.timestamp - s, name: id2name[x.abilityGameID] }))
    .sort((a, b) => a.t - b.t);
  if (casts.length < 5) return null;

  // Casts/min per ability over the whole fight -- the basis for "do you press
  // what the field presses". Free: we already have every (damage) cast here.
  const castRate = {};
  for (const c of casts) castRate[c.name] = (castRate[c.name] || 0) + 1;
  for (const k of Object.keys(castRate)) castRate[k] *= cpm;

  // castRateOnly: the cross-kill aggregation (medianCastRates) needs ONLY castRate, so
  // return before the per-hit / pet / dot fetches the full + onlyAbility paths do. Keeps
  // each EXTRA recent kill to the minimum reads already issued above (no petDamage etc.).
  if (opts.castRateOnly) return { castRate, allCastRate, dur, sourceID: m.sourceID };

  if (opts.onlyAbility) {
    const id = name2id[opts.onlyAbility];
    let procPerMin = 0, empShare = null;
    if (id) {
      const evs = await paginateEvents(code, fight, m.sourceID, eventTable(), id, s, e);
      const ph = perHit(evs);
      procPerMin = ph.procBig / (dur / 60 || 1);
      empShare = ph.empShare;             // field's empowered-cast share for this ability
    }
    // Return the per-ability damage TOTALS + cast rates too (no extra fetch -- they
    // ride on the playerMetrics table already loaded). The per-cast-damage lever
    // medians these across peers to see how hard the FIELD's same ability hits.
    // sourceID lets the caller resolve this peer's hero tree (same-tree matching).
    // Peer DoT uptimes for the caller's DoT ids (so the field comparison is on the
    // SAME DoTs as you) -- one batched query, only when asked.
    const dotUp = (opts.dotIds && opts.dotIds.length) ? await dotUptimes(code, fight, m.sourceID, opts.dotIds, e - s) : {};
    const petDmg = await petDamage(code, fight, m.sourceID);
    const petShare = (m.total + petDmg) > 0 ? petDmg / (m.total + petDmg) : 0;
    // Damage distribution over fight progress (for the weak-window comparison) -- ALL this
    // peer's damage events, bucketed by % of the fight. One unfiltered fetch (deduped).
    const dmgCurve = damageCurve(await paginateEvents(code, fight, m.sourceID, eventTable(), null, s, e), s, e - s);
    return { opener: openerSequence(casts), procPerMin, empShare, castRate, allCastRate, name2id, castTimesById,
             dmgBy: m.dmgBy, total: m.total, dur, sourceID: m.sourceID, dotUp, petShare, dmgCurve };
  }

  // You: per-hit detail for the top damage abilities (bounded for API cost).
  const top = abils.slice(0, opts.topN || 4);
  const hits = [];
  // Damage TIMELINE for the buff-window measurement, built from the SAME top-ability
  // events we already paginate here (no extra fetch -- riding existing data, which
  // keeps the one-fetch-per-report rule). A damage BUFF lifts these (your biggest
  // abilities) in the window after each cast; that uplift SIZES the missed-cast cost
  // once the self-buff causal gate has confirmed the candidate is really a buff.
  const dmgTimeline = [];
  for (const a of top) {
    const evs = await paginateEvents(code, fight, m.sourceID, eventTable(), a.guid, s, e);
    if (evs.length) {
      const ph = perHit(evs);
      hits.push({ name: a.name, ...ph, procPerMin: ph.procBig / (dur / 60 || 1) });
      for (const ev of evs) dmgTimeline.push({ t: ev.timestamp - s, amount: ev.amount || 0 });
    }
  }
  dmgTimeline.sort((p, q2) => p.t - q2.t);
  // Per-ability total damage (name -> total), so the cooldown lever can size a
  // missed cooldown by its MEASURED damage-per-cast rather than guessing.
  const dmgTotals = Object.fromEntries(abils.map((a) => [a.name, a.total]));
  // DoTs = ticking abilities that carry real damage (>=3% of your total) -- class-
  // agnostic, derived from the data (tickCount + share), not a hard-coded list. Fetch
  // their boss uptime so the field comparison can flag a CLIPPED DoT (lost damage
  // cast/cooldown levers can't see). { name, guid, share } + { guid: uptime% }.
  const dmgTotal = abils.reduce((sm, a) => sm + (a.total || 0), 0) || 1;
  const dots = abils.filter((a) => (a.tickCount || 0) > 0 && a.total / dmgTotal >= 0.03)
    .map((a) => ({ name: a.name, guid: a.guid, share: a.total / dmgTotal }));
  const dotUp = dots.length ? await dotUptimes(code, fight, m.sourceID, dots.map((d) => d.guid), e - s) : {};
  const petDmg = await petDamage(code, fight, m.sourceID);
  const petShare = (m.total + petDmg) > 0 ? petDmg / (m.total + petDmg) : 0;

  // ATONEMENT healers (Discipline always; fistweaving Mistweaver) heal THROUGH damage, so
  // their DAMAGE buttons -- not the Healing table everything above read (Atonement OUTPUT) --
  // are the rotation lever. Fetch the DamageDone table ONCE and RE-POINT the rotation inputs
  // (castRate / dmgTotals / total) to the damage view, naming the damage cast rate by filtering
  // the all-casts rate (by id, already computed) to the damage abilities. The healing-efficiency
  // levers use a SEPARATE object (prescribe's `you`), so this only re-aims the rotation analysis.
  // Sizing by damage % is valid as % of HPS: atonement healing scales ~linearly with damage, so
  // a missed/total DAMAGE ratio equals the missed/total HEALING ratio. dmgId2Name lets the caller
  // build the FIELD's damage rate from peers' (already-fetched) all-casts rates -- no peer fetch.
  let rotCastRate = castRate, rotDmgTotals = dmgTotals, rotTotal = m.total, atonement = false, dmgId2Name = null;
  if (runIsHealer() && (alwaysAtonement(specName) || atonementIfDamaging(specName))) {
    const dmgAbils = await damageAbilitiesForced(code, fight, m.sourceID);
    const dmgSum = dmgAbils.reduce((sm, a) => sm + (a.total || 0), 0);
    const dmgShare = (dmgSum + (m.total || 0)) > 0 ? dmgSum / (dmgSum + (m.total || 0)) : 0;
    if (dmgAbils.length && isAtonement(specName, dmgShare)) {
      atonement = true;
      dmgId2Name = {};
      const dmgRate = {};
      for (const a of dmgAbils) {
        dmgId2Name[a.guid] = a.name;
        if (allCastRate[a.guid]) dmgRate[a.name] = allCastRate[a.guid];
      }
      rotCastRate = dmgRate;
      rotDmgTotals = Object.fromEntries(dmgAbils.map((a) => [a.name, a.total]));
      rotTotal = dmgSum;
    }
  }
  // Your damage distribution over fight progress, for the weak-window comparison vs the
  // field. ALL your damage events (one unfiltered fetch, deduped), bucketed by % of fight.
  const dmgCurve = damageCurve(await paginateEvents(code, fight, m.sourceID, eventTable(), null, s, e), s, e - s);
  return { opener: openerSequence(casts), hits, dur, castRate: rotCastRate, allCastRate, dmgTotals: rotDmgTotals, total: rotTotal,
           sourceID: m.sourceID, name2id, dots, dotUp, petShare, castTimesById, dmgTimeline, atonement, dmgId2Name, dmgCurve };
}

// --- findings (data the prescription consumes) -------------------------------

// The ilvl-matched field for the rotation comparison, each peer analyzed the SAME way
// you were (analyzeKill), restricted to your hero tree. Via the shared core.ilvlPeers
// (same set overview / timeline / prescribe use, so fetches dedupe). If NO ilvl-matched
// peers exist (under-geared / low-pop spec), widen the window: which buttons you press,
// pet usage, and DoT uptime are ~ilvl-independent, so a slightly-higher-ilvl field is a
// valid PLAYSTYLE comparison and an approximate one beats none. Two hero trees swap whole
// buttons (a mixed field makes the cast-rate diff lie both ways), so we compare only to
// SAME-tree peers; hero detection is best-effort (null -> whole field). Returns the top 5.
async function fetchRotationPeers(name, server, region, boss, difficulty, className, specName, best, you, cand) {
  let cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName);
  if (!cands.length) cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName, { window: 15 });
  let yourHero = null;
  try { yourHero = await heroTreeOf(best.code, best.fight, you.sourceID); } catch (e) { /* no talent data */ }
  const analyzed = (await mapLimit(cands, 4, async (r) => {
    try {
      const a = await analyzeKill(r.name, r.report.code, r.report.fightID, specName, className,
                                  { onlyAbility: cand ? cand.name : "__noempower__", dotIds: (you.dots || []).map((d) => d.guid) });
      if (!a) return null;
      const hero = yourHero ? await heroTreeOf(r.report.code, r.report.fightID, a.sourceID).catch(() => null) : null;
      return { ...a, hero };
    } catch (e) { return null; }
  })).filter(Boolean);
  return { peers: sameHeroPeers(analyzed, yourHero).slice(0, 5), yourHero };
}

// Returns structured rotation findings. The key output is `proc`: a genuine
// empowerment proc (outsized NON-crit hits) you under-use vs the field -- an
// actionable list item. If big hits are merely crits, proc.isReal is false and
// NOTHING is recommended (a "big hit" is usually a crit, not a missed button).
/** @param {{code:any,fight:any,encounter:any}|null} [killOverride] @param {{code:any,fight:any}[]} [extraKills] */
export async function rotationFindings(name, server, region, className, specName, difficulty, killOverride = null, extraKills = []) {
  // Which kill we analyze. The rotation CARD analyzes your most-recent current-gear
  // kill (bestKill -- shared with gear/talents/topparse, so the fetch is cached).
  // PRESCRIBE passes its benchmark (median-parse) kill via killOverride, so the
  // rotation levers are measured on the SAME kill the gap is sized on -- otherwise a
  // player analyzed on their BEST kill (where they play well) shows tiny levers while
  // the gap, measured on a median kill, is huge, and the difference falls into the
  // residual. killOverride must carry { code, fight, encounter } (bestKill's shape).
  const best = killOverride || await bestKill(name, server, region, difficulty);
  if (!best) return null;
  const boss = best.encounter;
  const you = await analyzeKill(name, best.code, best.fight, specName, className, { topN: 5 });
  // Don't bail on empty hits: a PET-heavy spec (Demonology Warlock) has PETS as its
  // top damage abilities, whose per-hit events live under the PET's sourceID -- so
  // `hits` (the empowerment/biggest-hit analysis) comes back empty. That analysis is
  // a BONUS; the usage/cooldown/DoT/pet/castGap levers don't need it. Bailing here
  // killed ALL rotation levers for Demo Lock. Make empowerment optional instead.
  if (!you) return null;

  // AGGREGATE the cast rate across your recent kills of this boss so the under-press /
  // press-faster / cooldown comparison reflects how you TYPICALLY play it, not one pull's
  // noise. We re-analyze only the EXTRA kills (the lightweight onlyAbility path -- castRate,
  // no per-hit detail) and median per ability with the benchmark's. Everything else (per-cast
  // damage sizing, empowerment, dur, allCastRate, peers) stays on the representative benchmark
  // kill. Concurrent so gql() auto-batches the fetches. Degrades to benchmark-only if none load.
  // The benchmark kill's OWN cast rate, kept before we median across kills below.
  // Per-cast DAMAGE sizing must pair benchmark damage with benchmark casts (mixing
  // benchmark damage with a cross-kill-median cast count mis-scales per-cast damage,
  // which can flip the empowerment gate). The median rate is for the USAGE deficit only.
  const benchCastRate = you.castRate;
  if (extraKills && extraKills.length) {
    const extra = (await mapLimit(extraKills, 3, async (ek) => {
      try {
        const a = await analyzeKill(name, ek.code, ek.fight, specName, className, { castRateOnly: true });
        return a ? a.castRate : null;
      } catch (e) { return null; }
    })).filter(Boolean);
    if (extra.length) you.castRate = medianCastRates([you.castRate, ...extra]);
  }

  // `biggest` = your hardest-median hit, kept for the "biggest single-hit ability" display.
  const biggest = (you.hits || []).length ? [...(you.hits || [])].sort((a, b) => b.med - a.med)[0] : null;
  const empCand = empowermentCandidate(you.hits, you.dmgTotals, biggest);
  const isReal = empCand ? empCand.procBig >= 2 : false;   // null candidate -> no empowerment analysis

  // The ilvl-matched field (peers analyzed the SAME way as you), restricted to your hero
  // tree. Feeds the empowered-share + proc rate of the SAME candidate ability, the opener,
  // and the whole ability-usage comparison. One ability measured per peer, so picking
  // empCand over biggest adds NO fetch -- it just measures the RIGHT button.
  const { peers, yourHero } = await fetchRotationPeers(
    name, server, region, boss, difficulty, className, specName, best, you, empCand);
  const fieldProc = (isReal && peers.length) ? median(peers.map((a) => a.procPerMin)) : null;
  // Field's empowered-cast share of the candidate (median over peers who had enough hits to
  // judge). Pairs with your own share to SHOW the comparison and to gate the empowerment
  // lever -- equal shares means the gap is per-cast stats, not timing, so we stay silent.
  const empShares = peers.map((p) => p.empShare).filter((x) => x != null);
  const fieldEmp = (isReal && empShares.length >= 3) ? median(empShares) : null;
  const youEmp = empCand ? empCand.empShare : null;
  const fieldOpener = consensusOpener(peers.map((p) => p.opener));
  // For an ATONEMENT healer the rotation IS the damage rotation, so the field rate must be
  // the peers' DAMAGE cast rate -- built by filtering each peer's already-fetched all-casts
  // rate (by id) to YOUR damage abilities (dmgId2Name). No extra peer fetch. Otherwise the
  // normal metric-aware cast-rate field. Both you.castRate and the field are now the SAME
  // (damage) view for atonement, so usageDivergence compares like with like.
  const dmgId2Name = you.atonement ? (you.dmgId2Name || {}) : null;
  const fieldRate = dmgId2Name
    ? fieldCastRates(peers.map((p) => {
        const r = {};
        for (const [id, nm] of Object.entries(dmgId2Name)) if (p.allCastRate && p.allCastRate[id]) r[String(nm)] = p.allCastRate[id];
        return r;
      }))
    : fieldCastRates(peers.map((p) => p.castRate || {}));
  const usage = usageDivergence(you.castRate || {}, fieldRate);
  // Size each under-pressed damage ability by MEASURED damage (not a flat guess), so a
  // core ability you press far less than the field lands as a concrete %, not residual.
  const usageDmg = peers.length
    ? usageDamageGaps(usage.under, usage.over, you.dmgTotals || {}, you.dur, you.total, { benchRate: /** @type {Record<string,number>} */ (benchCastRate) })
    : {};
  for (const u of usage.under) if (usageDmg[u.name] != null) u.dmgPct = usageDmg[u.name];
  // Under-used damage cooldowns (the band usageDivergence's filler floor misses).
  // Dedupe against usage.under so the same ability isn't double-counted.
  const underNames = new Set(usage.under.map((a) => a.name));
  const cooldowns = (peers.length ? cooldownGaps(you.castRate || {}, fieldRate, you.dmgTotals || {}, you.dur) : [])
    .filter((c) => !underNames.has(c.name));
  // BUFF/PET cooldown usage gaps from ALL casts (the damage table can't see them).
  // Resolve names via Wowhead for just the top few divergent ids (bounded + cached).
  const fieldAllRate = fieldCastRates(peers.map((p) => p.allCastRate || {}));
  let cdUsage = [];
  let buffCds = [];
  if (peers.length) {
    const [fs, fe] = await fightWindow(best.code, best.fight);
    const yourTotal = you.total || Object.values(you.dmgTotals || {}).reduce((a, b) => a + b, 0) || 1;
    const gaps = castUsageGaps(you.allCastRate || {}, fieldAllRate, you.dur).slice(0, 5);
    // The player's OWN self-buff auras this kill, fetched ONCE (one bundled Buffs
    // table, sourceID-filtered -- the Buffs table with a sourceID returns the auras
    // ON the player). Reused across ALL buff candidates below; never per-candidate,
    // so the one-fetch-per-report rule holds. This is the CAUSAL gate (selfBuffMatch):
    // a candidate is a damage BUFF only if casting it put an aura on you -- a taunt/
    // utility (Provoke) grants no self-buff, so it is excluded BEFORE any uplift sizing.
    let selfBuffs = {};
    try { selfBuffs = await buffUptimes(best.code, best.fight, you.sourceID); } catch (e) { /* no buff data -> no buff levers */ }
    const timeline = you.dmgTimeline || [];
    const raw = await mapLimit(gaps, 3, async (g) => {
      const id = Number(g.id);
      // A targeted DamageDone check tells us whether this cooldown deals direct damage.
      let dmg = [];
      try { dmg = await paginateEvents(best.code, best.fight, you.sourceID, eventTable(), id, fs, fe); } catch (e) { return null; }
      let nm = null;
      try { const t = await spellTooltip(id); nm = t && t.name; } catch (e) { return null; }
      if (!nm || underNames.has(nm) || cooldowns.some((c) => c.name === nm)) return null;
      if (dmg.length) {
        // DIRECT-DAMAGE cooldown: size from your own damage-per-cast (existing lever).
        const abilityDmg = dmg.reduce((sm, x) => sm + (x.amount || 0), 0);
        const dpc = perCastValue(abilityDmg, g.youPerFight, 1);
        const pct = dmgGapPct(g.fieldPerFight - g.youPerFight, dpc, yourTotal);
        return { kind: "cd", name: nm, youPerFight: g.youPerFight, fieldPerFight: g.fieldPerFight, id, pct };
      }
      // NO direct damage -> candidate BUFF (Weapons of Order, Recklessness, Avatar) OR
      // a taunt/utility/defensive (Provoke, Fortifying Brew). The CAUSAL gate: this is
      // a damage buff ONLY if casting it granted YOU a self-buff aura. A taunt does
      // NOT -> excluded here (the windowed uplift never even runs), which is exactly
      // the Provoke false positive the correlational classifier let through.
      if (!selfBuffMatch(id, nm, selfBuffs)) return null;
      const castTimes = (you.castTimesById || {})[id];
      if (!castTimes || castTimes.length < 2 || !timeline.length) return null;
      // ONLY after the self-buff gate passes do we size by the windowed uplift.
      const upl = buffWindowUplift(castTimes, timeline);
      const sized = buffCdGap(g, upl, yourTotal);
      if (!sized) return null;
      return { kind: "buff", name: nm, id, ...sized };
    });
    const found = raw.filter(Boolean);
    cdUsage = found.filter((x) => x.kind === "cd").slice(0, 3);
    buffCds = found.filter((x) => x.kind === "buff").slice(0, 2);
  }
  // Measured total damaging-ability casts/min, you vs field -- the direct "are
  // you pressing as often as they are" gap (sizes the press-faster lever).
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const youCpm = sum(you.castRate), fieldCpm = sum(fieldRate);
  const castGap = { you: youCpm, field: fieldCpm, pct: fieldCpm > 0 ? Math.round(((fieldCpm - youCpm) / fieldCpm) * 100) : 0 };
  // Per-cast DAMAGE gaps: your top abilities vs the field's SAME ability. The
  // field's per-ability totals + cast rates ride on peer fetches we already did
  // (no new query). overallRatio is the field's general damage edge (comp+stats),
  // so the lever fires only on abilities behind by MORE than that -- the
  // ability-specific empowerment gap that hides in the playstyle remainder.
  let perCast = [];
  if (peers.length) {
    const yourMins = you.dur ? you.dur / 60 : 0;
    const yourAb = {};
    for (const h of (you.hits || [])) {
      // Benchmark casts (not the cross-kill median) so per-cast = benchmark damage /
      // benchmark casts -- the true per-cast value the empowerment gate keys on.
      const casts = ((benchCastRate || {})[h.name] || 0) * yourMins;
      const total = (you.dmgTotals || {})[h.name] || 0;
      if (casts > 0 && total > 0) yourAb[h.name] = { total, casts };
    }
    const fieldAb = {};
    for (const nm of Object.keys(yourAb)) {
      const pcs = peers.map((p) => {
        const c = ((p.castRate || {})[nm] || 0) * (p.dur ? p.dur / 60 : 0);
        return c >= 1 && (p.dmgBy || {})[nm] ? p.dmgBy[nm] / c : null;
      }).filter((x) => x != null);
      if (pcs.length >= 3) fieldAb[nm] = median(pcs);
    }
    const peerTotals = peers.map((p) => p.total).filter((x) => x > 0);
    const overallRatio = peerTotals.length ? median(peerTotals) / (you.total || 1) : 1;
    perCast = perCastGaps(yourAb, fieldAb, overallRatio, you.total ||
      Object.values(you.dmgTotals || {}).reduce((a, b) => a + b, 0));
    // Tag the candidate's per-cast gap with the empowered-share comparison (+ the concrete
    // counts), so the lever can decide WHY it's behind: a lower empowered share -> timing
    // (empower it more); equal shares -> uniform per-cast stats (leave it in the remainder).
    for (const pc of perCast) {
      if (empCand && pc.name === empCand.name) Object.assign(pc, { youEmp, fieldEmp, youEmpCount: empCand.empCount, youEmpN: empCand.empN });
    }
  }
  // Your talented abilities, so the prescription can tell a skipped talent from a
  // baseline ability you simply aren't pressing (don't tell people to "respec"
  // for a baseline button). Best-effort: null if CombatantInfo/Raidbots missing.
  let talent = null;
  try {
    talent = await talentedAbilities(best.code, best.fight, you.sourceID);
  } catch (e) { /* no talent data -> levers treat under-use as a rotation fix */ }
  // (The card + lever filter usage.under through castable() so they never tell you
  // to "press more" a button you didn't talent.)
  // Merged ability name -> Wowhead spell id (yours + the field's), so the
  // prescription can link every ability it names (under/over-press, proc, the
  // never-pressed field ability). Yours wins on collision.
  const abilityIds = Object.assign({}, ...peers.map((p) => p.name2id || {}), you.name2id || {});
  // DoT-uptime gaps: field-median uptime per DoT vs yours -> a clipped DoT is lost
  // damage the cast/cooldown levers can't see (THE missing lever for DoT specs).
  const fieldUp = {};
  for (const d of (you.dots || [])) {
    const ups = peers.map((p) => (p.dotUp || {})[d.guid]).filter((x) => x != null);
    if (ups.length >= 3) fieldUp[d.guid] = median(ups);
  }
  const dotGaps = dotUptimeGaps(you.dots || [], you.dotUp || {}, fieldUp);
  // Pet-damage share gap: pet-heavy specs hide a big chunk of the playstyle remainder
  // in pet under-use (Army/Gargoyle/Dark Transformation timing). Field-median share.
  const petShares = peers.map((p) => p.petShare).filter((x) => x != null);
  const fieldPetShare = petShares.length >= 3 ? median(petShares) : null;
  const petGap = (you.petShare != null && fieldPetShare != null) ? petShareGap(you.petShare, fieldPetShare) : null;
  const heroMatched = yourHero && peers.length ? (peers.every((p) => p.hero === yourHero) ? yourHero : null) : null;
  // OPENER divergence: a high-consensus early cooldown the field opens with that you
  // delay/skip. A named DIAGNOSTIC, gated hard so it never nags a good player:
  //   - only when you're BEHIND the field on this kill (a faster opener can't be the
  //     story for someone already ahead -- Hadryan delays Niuzao yet parses +45%);
  //   - only when peers are HERO-MATCHED (a different build opens with different buttons,
  //     so the comparison would be confounded -- mirror the press-more buildCaveat);
  //   - only an ability you can actually CAST (don't tell you to open with a skipped talent).
  // Compared on total damage / duration (peers + you are on the same boss). Damage-only,
  // so suppressed for a PURE healer the same way usageLevers is (reactive misframe).
  const yourDps = (you.total && you.dur) ? you.total / you.dur : 0;
  const peerDpss = peers.map((p) => (p.total && p.dur) ? p.total / p.dur : null).filter((x) => x != null);
  const fieldMedDps = peerDpss.length >= 3 ? median(peerDpss) : null;
  const behindField = fieldMedDps != null && yourDps > 0 && yourDps < fieldMedDps * 0.97;
  const heroSafe = !yourHero || !!heroMatched;       // unknown hero = best-effort; known = require a match
  const rotationSafe = behindField && heroSafe && (!runIsHealer() || you.atonement);
  let openerGap = null;
  if (rotationSafe) {
    const og = openerDivergence(you.opener, peers.map((p) => p.opener));
    if (og && castable(og.ability, talent)) openerGap = og;
  }
  // CD ALIGNMENT: do you fire your major cooldowns STACKED (one multiplicative burst) like
  // the field, or scattered? The cast-count levers can't see it -- you can press each the
  // right NUMBER of times yet never overlap them. Measured (your stack fraction vs the
  // field's), but surfaced as a NAMED diagnostic only (no DPS size until live-validated).
  let cdAlign = null;
  if (rotationSafe) {
    const youCdIds = majorCooldownIds(you.allCastRate || {});
    const youStack = cooldownStackFraction(you.castTimesById || {}, youCdIds);
    const fieldStacks = peers.map((p) => cooldownStackFraction(p.castTimesById || {}, majorCooldownIds(p.allCastRate || {})));
    // Aggregate cooldown cast RATE, you vs field -- the guard so "you scatter" can't be a
    // mere artifact of under-using them (that's the cooldown-USAGE lever, not alignment).
    const youCdRate = youCdIds.reduce((s, id) => s + ((you.allCastRate || {})[id] || 0), 0);
    const fieldCdRates = peers.map((p) => majorCooldownIds(p.allCastRate || {}).reduce((s, id) => s + ((p.allCastRate || {})[id] || 0), 0));
    if (cooldownUseComparable(youCdRate, fieldCdRates)) cdAlign = cooldownStackGap(youStack, fieldStacks);
  }
  // WEAK WINDOW: the stretch of the fight where your DPS trails the field's the most -- the
  // SHAPE of your damage curve, which every rate/share/uptime aggregate misses. NOT gated on
  // being behind overall (unlike opener/CD-align): it compares ABSOLUTE rate with an
  // intermission guard, so an ahead player who just front-loads never trips it, but a real
  // dip below the field surfaces even for someone ahead on totals (the whole point -- finding
  // where an otherwise-good player still bleeds). Hero-matched + not a pure healer (curve of
  // a different build / a reactive healer isn't comparable). Also NOT a SUPPORT spec (Aug):
  // their personal-damage curve ebbs while they spend GCDs on ally buffs -- that's correct
  // play, not a hole, and would read as a false weak window (support is framed by buff value).
  const wwGate = heroSafe && (!runIsHealer() || you.atonement) && !runIsSupport();
  // YOUR death times (fight-progress fractions) so weakestWindow's death guard can drop bins
  // you spent dead -- a death is a survival finding, not "press more". One fetch, only when
  // the lever will run (best-effort: no death data just means no guard). The kill's window is
  // already cached from analyzeKill, so fightWindow is free here.
  const yourDeaths = [];
  if (wwGate) {
    try {
      const [ds, de] = await fightWindow(best.code, best.fight);
      for (const x of await reportDeaths(best.code, [best.fight])) {
        if (x.targetID !== you.sourceID || !(de > ds)) continue;
        const fr = (x.timestamp - ds) / (de - ds);
        if (fr >= 0 && fr <= 1) yourDeaths.push(fr);
      }
    } catch (e) { /* no death data -> no guard, lever still runs */ }
  }
  const weakWindow = wwGate
    ? weakestWindow(you.dmgCurve, peers.map((p) => p.dmgCurve).filter(Boolean), { deaths: yourDeaths })
    : null;
  return {
    boss: boss.name, hits: you.hits, biggest, opener: you.opener, fieldOpener, atonement: !!you.atonement,
    usage, cooldowns, cdUsage, buffCds, perCast, dotGaps, dotCount: (you.dots || []).length, petGap, castGap, fieldPeers: peers.length, talent, abilityIds, openerGap, cdAlign, weakWindow,
    yourHero: yourHero || null,
    heroMatched,
    proc: { name: empCand ? empCand.name : null, isReal, youPerMin: empCand ? empCand.procPerMin : 0, fieldPerMin: fieldProc, youEmp, fieldEmp,
            youEmpCount: empCand ? empCand.empCount : null, youEmpN: empCand ? empCand.empN : null },
  };
}

// --- entry point (prints what rotationFindings computed) ----------------------

export async function run(log, name, server, region, className = "Monk",
                         specName = "Brewmaster", difficulty = 5) {
  const fnd = await rotationFindings(name, server, region, className, specName, difficulty);
  if (!fnd) { log("[error] could not read your casts/damage"); return; }
  log(`Rotation analysis on ${fnd.boss} (your most recent kill at current gear). ` +
      `Spec-agnostic: nothing about ${specName} is hard-coded.`);

  // Pet-heavy specs (Demo Lock) have no player-sourced per-hit data -> no hits.
  if ((fnd.hits || []).length && fnd.biggest) {
    log("");
    log(`=== YOUR ${runIsHealer() ? "BIGGEST HEALS" : "HARDEST-HITTING ABILITIES"} (per cast) ===`);
    for (const h of [...(fnd.hits || [])].sort((a, b) => b.med - a.med))
      log(`  ${h.name.padEnd(20)} median ${Math.round(h.med).toLocaleString().padStart(8)}  ` +
          `max ${Math.round(h.max).toLocaleString().padStart(8)}  (${Math.round(h.critPct)}% crit, ` +
          `${h.procBig} non-crit big hits)`);
    log(`  -> biggest single-hit ability: ${fnd.biggest.name}`);
  }

  // Empowerment / "big hits are crits" is a DAMAGE framing -- for a healer there's
  // no empower window to chase, and a big cooldown heal's outsized cluster can look
  // like a proc. Skip it on an HPS run; the healer's efficiency evidence lives in
  // the Healing efficiency card (healing.js), and cooldown USAGE is below.
  if (!runIsHealer()) {
    log("");
    if (!fnd.proc.isReal) {
      log("=== BIG HITS ARE CRIT-DRIVEN, NOT A PROC ===");
      log("  Your outsized hits are crits, not a missed empowerment button. More big");
      log("  hits = more crit + raid damage buffs (comp), not a rotation change.");
    } else {
      const p = fnd.proc;
      log(`=== EMPOWERMENT (${p.name}, high-damage casts) ===`);
      if (p.youEmp != null && p.fieldEmp != null) {
        const cnt = (p.youEmpCount != null && p.youEmpN)
          ? `  (you ${p.youEmpCount}/${p.youEmpN}, field ~${Math.round(p.fieldEmp * p.youEmpN)}/${p.youEmpN})`
          : "";
        log(`  empowered casts:  you ${Math.round(p.youEmp * 100)}%   peers ${Math.round(p.fieldEmp * 100)}%${cnt}`);
        log(p.fieldEmp - p.youEmp >= 0.12
          ? `  -> Fewer than peers -- land ${p.name} in its empower/amp window more often.`
          : `  -> About the same as peers. Your ${p.name} lands in its window as often; the per-cast gap is stats/comp/fight-amp, not timing.`);
      } else {
        log(`  proc hits/min:  you ${p.youPerMin.toFixed(1)}   peers ${p.fieldPerMin == null ? "?" : p.fieldPerMin.toFixed(1)}`);
      }
    }
  }

  log("");
  log("=== OPENER ===");
  log(`  your opener:  ${fnd.opener.join(" > ")}`);
  if (fnd.fieldOpener) log(`  peers' opener: ${fnd.fieldOpener.join(" > ")}`);

  // DAMAGE OVER TIME: the shape of your damage vs the field. The weak window (if any) is
  // the stretch you trail them most, intermissions excluded -- the thing aggregates miss.
  if (!runIsHealer() && fnd.weakWindow) {
    const w = fnd.weakWindow;
    log("");
    log("=== DAMAGE OVER TIME (vs field) ===");
    log(`  weakest stretch: ${Math.round(w.from * 100)}-${Math.round(w.to * 100)}% of the fight -- ` +
        `your ${throughputWord()} drops to ~${Math.round(w.youDps / 1000)}k vs your usual ~${Math.round(w.yourTypical / 1000)}k (field still ~${Math.round(w.fieldDps / 1000)}k, so not an intermission).`);
    log(`  -> holding your normal output there is ~${Math.max(1, Math.round(w.lostFrac * 100))}% of your total; find what stops you and keep uptime through it.`);
  }

  const u = fnd.usage || { under: [], over: [] };
  // Only recommend pressing abilities you can actually cast -- the peer pool can
  // skew to a different hero tree and surface buttons your build doesn't have.
  const under = u.under.filter((a) => castable(a.name, fnd.talent));
  // Drop over-press findings that are really a hero-tree/build difference (you
  // press a button the field replaced) rather than a rotation error.
  const over = realOveruse(u.over, fnd.heroMatched);
  // HEALERS: the raw "press X more / less" cast-rate diff is the reactive misframe
  // (you cast to match incoming damage, not to a target rate) -- suppress it. The
  // valid healer rotation signal is cooldown USAGE (printed via the prescription's
  // COOLDOWN items) + the Healing efficiency card.
  if (!runIsHealer() && (under.length || over.length)) {
    log("");
    log(`=== ABILITY USAGE vs PEERS (casts/min, ${fnd.fieldPeers} peers` +
        `${fnd.heroMatched ? `, all on ${fnd.heroMatched}` : ""}) ===`);
    for (const a of under.slice(0, 4))
      log(`  UNDER-USE  ${a.name.padEnd(20)} you ${a.you.toFixed(1)}/min  peers ${a.field.toFixed(1)}/min  <-- press it more`);
    for (const a of over.slice(0, 4))
      log(`  OVER-USE   ${a.name.padEnd(20)} you ${a.you.toFixed(1)}/min  peers ${a.field.toFixed(1)}/min  <-- peers press this less`);
    if (under.length) log("  -> Shift presses toward what peers actually cast.");
  }
}

// Findings for prescribe.js (rotation domain), split by lever kind below; rotationLevers
// concatenates them. Biggest rotation lever: where your ability USAGE diverges from the field. Pressing
// the wrong button (over-use one, never press the field's) or skipping a cooldown is
// usually the largest gap for an underperformer. A never-pressed talent is a respec
// (flat estimate); under-pressed damage abilities are sized from real damage.
// Tag a rotation lever with a BOSS-INDEPENDENT identity (its kind + the ability it
// names), so prescribe can tell a CONSISTENT habit -- the same lever firing across
// several of your recent bosses -- from a one-fight artifact. The spec is the same on
// every boss, so "press Blackout Kick more" keys identically on any fight; only the
// boss-specific numbers in the text differ. Talent/build levers stay UNKEYED on purpose:
// a skipped talent is constant across bosses, so "recurrence" there is meaningless.
const withKey = (f, key) => ({ ...f, recurKey: key });

function usageLevers(rot, link) {
  const out = [];
  // HEALERS: usageLevers is built ENTIRELY from DAMAGE-cast divergence -- for a PURE healer
  // that's a misframe ("press this damage ability more" / "respec for this damage talent" --
  // healing is reactive; casting into less damage just overheals). EXCEPTION: ATONEMENT-style
  // healers (Discipline, fistweaving Mistweaver) heal THROUGH damage, so their damage rotation
  // IS the healing lever -- for them rotationFindings re-pointed castRate/dmgTotals to the
  // DAMAGE table (you.atonement), so the under-press analysis is valid HPS advice and we keep
  // it. A pure healer's rotation lever stays overhealing (healing.js); their build, talentLevers.
  if (runIsHealer() && !(rot && rot.atonement)) return out;
  const u = rot && rot.usage;
  // Over-press findings, minus hero-tree/build differences (see realOveruse): a
  // button the field replaced isn't something you're pressing "too much".
  const realOver = u ? realOveruse(u.over, rot && rot.heroMatched) : [];
  if (u && u.under.length) {
    const top = u.under[0];
    const overTop = realOver[0];
    // Never casting an ability the field leans on USED to be reported as "missing
    // the talent -- respec". That over-reached on baseline buttons (a Prot Paladin
    // told to respec for Shield of the Righteous). Now we check YOUR talents:
    // only call it a missing talent if it's actually a talent you skipped; if you
    // specced it but don't press it, it's a build/usage problem; a baseline button
    // you skip falls through to the ordinary "press it more" rotation fix.
    const cls = classifyUnderUse(top, rot && rot.talent);
    const onGlobals = overTop ? ` Right now you spend those globals on ${link(overTop.name)}.` : "";
    // The top under-use can be a BUILD problem (a talent you skipped, or one you took
    // but never press) -- that's a respec, sim-priced, so it keeps the flat estimate.
    // We consume only that ONE ability here; the rest still get the measured press-more
    // treatment below (the old code dropped them when the top was a talent issue).
    let consumed = null;
    if (cls === "missing-talent") {
      consumed = top.name;
      out.push(finding(DIM.ROTATION, DPS(5, 10),
        `TALENTS/BUILD: you never press ${link(top.name)}, and you haven't talented it while the field casts it ` +
        `${f(top.field, 1)}/min -- respec to the field's build (the one with ${link(top.name)}); your rotation ` +
        `can't include it until you do.${onGlobals}`, "est", KIND.TALENTS));
    } else if (cls === "talented-unused") {
      consumed = top.name;
      out.push(finding(DIM.ROTATION, DPS(5, 10),
        `TALENTS/BUILD: you've talented ${link(top.name)} but never press it, while the field casts it ` +
        `${f(top.field, 1)}/min -- a wasted talent. Work it into your rotation, or respec the point into ` +
        `something you'll actually use.${onGlobals}`, "est", KIND.TALENTS));
    }
    // Measured PRESS-MORE levers: one TARGETED finding per under-pressed damage ability,
    // each sized from real damage (usageDamageGaps -> a.dmgPct). This is the chunk that
    // used to hide in the "playstyle" residual -- pressing a core ability far less than
    // the field is lost damage we can now name AND size, not a flat 3-6% guess.
    // Only abilities you can actually cast (peer pool can skew hero tree); the
    // never-pressed talent above is excluded. (Healers never reach here -- the whole
    // function early-returns for them.)
    const underAbilities = u.under.filter((a) => a.name !== consumed && castable(a.name, rot && rot.talent));
    const measured = underAbilities.filter((a) => (a.dmgPct || 0) >= 1).sort((a, b) => b.dmgPct - a.dmgPct);
    // OFF-BUILD: when your hero tree is known but the rotation peer pool ISN'T it (too few
    // same-tree peers at your ilvl, so sameHeroPeers fell back to the off-tree field), a
    // per-ability cast-rate gap is CONFOUNDED -- the field's optimal mix is for a different
    // build, not yours. Mirror realOveruse's build-awareness (which already guards over-press):
    // don't claim a confident misplay; flag that it may be the build and the reliable read is
    // to switch + re-run. Keeps the impact (reconcile owns the gap) -- only the claim softens.
    const offBuild = !!(rot && rot.yourHero && !rot.heroMatched);
    const buildCaveat = offBuild
      ? ` (but the field runs a different hero tree -- see HERO TREE -- so this may be a build difference, not a misplay; switch to the field's build and re-run for a same-build read)`
      : "";
    measured.slice(0, 3).forEach((a, i) => {
      // Name the wrong-button swap once, on the biggest, when you over-press a filler.
      const over = (i === 0 && realOver.length)
        ? ` You're spending those globals on ${link(realOver[0].name)} (your ${f(realOver[0].you, 1)}/min vs peers ${f(realOver[0].field, 1)}) -- swap them.`
        : "";
      out.push(withKey(finding(DIM.ROTATION, DPS(a.dmgPct),
        `ROTATION: press ${link(a.name)} more -- peers cast it ${f(a.field, 1)}/min vs your ${f(a.you, 1)}; ` +
        `the casts you're missing are ~${a.dmgPct}% of your ${throughputWord()}.${over}${buildCaveat}`, "measured"), `press:${a.name}`));
    });
    // Fallback: when NONE could be measured (no peers, or too few of your own casts to
    // get a per-cast), keep the old lumped flat estimate so the lever still surfaces.
    const unmeasured = underAbilities.filter((a) => !((a.dmgPct || 0) >= 1));
    if (!measured.length && unmeasured.length) {
      const under = unmeasured.slice(0, 2).map((a) => `${link(a.name)} (peers ${f(a.field, 1)}/min vs your ${f(a.you, 1)})`);
      const wrongButton = realOver.length > 0;
      const over = wrongButton
        ? `; you over-press ${realOver.slice(0, 1).map((a) => `${link(a.name)} (your ${f(a.you, 1)}/min vs peers ${f(a.field, 1)})`).join("")}`
        : "";
      out.push(finding(DIM.ROTATION, wrongButton ? DPS(5, 10) : DPS(3, 6),
        `ROTATION: press ${under.join(" and ")} more${over} -- match your peers' ability priority ` +
        `(verify in a log/sim).`));
    }
  }
  return out;
}

// Under-used DAMAGE COOLDOWNS -- a measured PLAYSTYLE lever (the kind that explains a
// big remainder; gear/sims don't). Sized from real damage-per-cast. Two sources:
// cooldowns (the truncated damage table) and cdUsage (cast events, which catch cooldowns
// beyond the top-5 the damage table shows). Dedupe by name.
function cooldownLevers(rot, link) {
  const out = [];
  const seenCd = new Set();
  for (const cd of ((rot && rot.cooldowns) || []).slice(0, 2)) {
    if (cd.pct && cd.pct >= 1) {
      seenCd.add(cd.name);
      out.push(withKey(finding(DIM.ROTATION, DPS(cd.pct),
        `COOLDOWN: you cast ${link(cd.name)} ${cd.youCasts.toFixed(1)}x this fight (${f(cd.you, 1)}/min) vs the field's ` +
        `${cd.fieldCasts.toFixed(1)}x (${f(cd.field, 1)}/min) -- ~${cd.pct}% of your ${throughputWord()}. Use it on cooldown ` +
        `(or line it up with your burst); it's a button you're skipping, not gear.`, "measured", KIND.COOLDOWN), `cd:${cd.name}`));
    }
  }
  for (const cd of ((rot && rot.cdUsage) || [])) {
    if (cd.pct && cd.pct >= 1 && !seenCd.has(cd.name)) {
      seenCd.add(cd.name);
      out.push(withKey(finding(DIM.ROTATION, DPS(cd.pct),
        `COOLDOWN: you cast ${wowheadSpell(cd.id, cd.name)} ${cd.youPerFight.toFixed(0)}x/kill vs the field's ` +
        `${cd.fieldPerFight.toFixed(0)}x -- ~${cd.pct}% of your ${throughputWord()}. Use it on cooldown; it's a button you're ` +
        `skipping, not gear.`, "measured", KIND.COOLDOWN), `cd:${cd.name}`));
    }
  }
  return out;
}

// BUFF COOLDOWN: a damage-buff cooldown (Weapons of Order, Recklessness, Avatar) you
// press LESS than the field. These deal NO direct damage, so cooldownGaps/cdUsage can't
// see OR size them. The CAUSAL gate already confirmed it's a real buff (casting it put a
// self-buff aura on you -- a taunt/utility like Provoke grants none and was excluded),
// and the windowed uplift SIZED it: missed casts x the window's extra throughput. The
// "never recommend a defensive/taunt" guarantee is the self-buff aura check, not a
// correlation that pull/burst timing could fake. Measured.
function buffCdLevers(rot) {
  const out = [];
  for (const b of ((rot && rot.buffCds) || [])) {
    if (b.pct && b.pct >= 1) {
      out.push(withKey(finding(DIM.ROTATION, DPS(b.pct),
        `BUFF COOLDOWN: you cast ${wowheadSpell(b.id, b.name)} ${b.youPerFight.toFixed(0)}x/kill vs the field's ` +
        `${b.fieldPerFight.toFixed(0)}x -- it buffs you, and your ${throughputWord()} rises ~${Math.round(b.uplift * 100)}% in the window after each cast, ` +
        `so missing it costs ~${b.pct}% of your ${throughputWord()}. Use it on cooldown (line it up with your burst); ` +
        `it's a buff you're skipping, not gear.`, "measured"), `buffcd:${b.name}`));
    }
  }
  return out;
}

// PET DAMAGE: a pet-heavy spec whose pets do less of its damage than the field's is
// under-using its biggest hidden lever (summon/transform/Army timing). Measured.
function petLever(rot) {
  const out = [];
  if (rot && rot.petGap) {
    const g = rot.petGap;
    out.push(withKey(finding(DIM.ROTATION, DPS(g.pct),
      `PET ${throughputWord().toUpperCase()}: your pets do ${g.you}% of your ${throughputWord()} vs the field's ${g.field}% -- ~${g.pct}% behind. ` +
      `Use your pet cooldowns more: summon it on cooldown, keep it active, and line up its burst cooldowns ` +
      `with your damage windows. It's a major damage source you're under-using, not gear.`, "measured"), "pet"));
  }
  return out;
}

// DoT UPTIME: a damage-over-time you keep up LESS than the field is lost damage
// that cast/cooldown levers can't see -- THE missing lever for DoT specs. Measured
// (boss uptime vs the field's), sized by the DoT's damage share x the shortfall.
function dotLevers(rot) {
  const out = [];
  for (const d of ((rot && rot.dotGaps) || []).slice(0, 2)) {
    // Don't assume a dedicated "refresh" button: some high-uptime DoTs are auto-applied
    // by your other casts/crits (Astral Smolder, Burning Blades, Deep Wounds) rather
    // than hardcast (Rip, Moonfire), so "refresh it / you have the buttons" is wrong for
    // those. Phrase the FIX to fit both -- keep its uptime up; it drops when you clip it,
    // let it lapse in movement, or slow the casts that apply it -- the gain is the same.
    out.push(withKey(finding(DIM.ROTATION, DPS(d.pct),
      `DOT UPTIME: your ${wowheadSpell(d.guid, d.name)} is up ${d.you}% on the boss vs the field's ${d.field}% ` +
      `-- ~${d.pct}% of your ${throughputWord()}. Keep its uptime up: refresh it before it falls off (or, if it's ` +
      `auto-applied by your other casts/crits, keep those flowing), and don't let it lapse in movement -- that uptime is ~free ${throughputWord()}.`, "measured"), `dot:${d.guid}`));
  }
  return out;
}

// EMPOWERMENT: your biggest hit lands in its high-damage window LESS than the
  // field. We only claim this when the EVIDENCE shows it -- your empowered-cast
  // SHARE actually trails the field's. A per-cast DAMAGE gap alone isn't enough:
  // it's confounded (comp re-attribution, a boss's damage-taken debuff, stat
  // scaling all make the field's same ability hit harder without you doing anything
  // wrong). The empowered SHARE is a within-player fraction, so it's robust to all
  // of that -- and the advice ("land your hardest hit inside its window") is the
  // same whether the window is a self-combo or a target debuff. Sized by the
  // per-cast gap, but gated so it can't fire on a uniform stat/amp gap.
  // HEALERS: no empowerment lever. "Land your hardest hit in its high-damage window"
  // is a damage-mechanic concept; a big cooldown heal's outsized cluster can also
  // false-trigger the underlying proc detection. A healer's efficiency lever is
// overhealing (healing.js), not empowerment timing.
function empowermentLever(rot, link) {
  const out = [];
  const emp = !runIsHealer() && ((rot && rot.perCast) || []).find(
    (pc) => pc.youEmp != null && pc.fieldEmp != null && pc.pct >= 1 &&
            pc.fieldEmp >= 0.2 && pc.fieldEmp - pc.youEmp >= 0.12);
  if (emp) {
    // Concrete counts when we have them ("41/78 vs ~62/78") -- the field count is its
    // SHARE applied to YOUR cast total, so it's an apples-to-apples "of the same casts".
    const count = (emp.youEmpCount != null && emp.youEmpN)
      ? ` (you land ${emp.youEmpCount}/${emp.youEmpN}; the field lands ~${Math.round(emp.fieldEmp * emp.youEmpN)}/${emp.youEmpN} of the same casts)`
      : "";
    out.push(withKey(finding(DIM.ROTATION, DPS(emp.pct),
      `EMPOWERMENT: ${Math.round(emp.youEmp * 100)}% of your ${link(emp.name)} casts land in its high-damage window ` +
      `vs the field's ${Math.round(emp.fieldEmp * 100)}%${count} -- your weak casts hit for roughly half. ` +
      `Line ${link(emp.name)} up with its empower window (its combo/buff/proc, or the boss's damage-taken window) every time.`,
      "measured", KIND.EMPOWERMENT), `emp:${emp.name}`));
  }
  return out;
}

// OPENER: your opening SEQUENCE diverges from the field's. A NAMED rotation DIAGNOSTIC,
// not a sized lever -- the opening window is hard to price in DPS and a sim won't value it,
// so it carries INFO (impact 0) and never inflates the list. The TRIGGER is the field's
// consensus FIRST cast (their opening cooldown) that you delay/skip -- the highest-confidence
// divergence -- but we SHOW both full opening sequences (like the rotation card) so it's a
// real sequence comparison, not one spell. rotationFindings already gated it to BEHIND-the-
// field, hero-matched, castable players, so a good player who opens fine never reaches here.
function openerLever(rot, link) {
  const og = rot && rot.openerGap;
  if (!og) return [];
  const share = Math.round(og.peerShare * 100);
  const fo = (rot.fieldOpener || []).slice(0, 7);
  const yo = (rot.opener || []).slice(0, 7);
  const lead = og.omitted
    ? `you never open with ${link(og.ability)} -- the field leads with it (${share}% of peers)`
    : `you push ${link(og.ability)} back ${og.delay} global${og.delay === 1 ? "" : "s"} -- the field leads with it (${share}% of peers)`;
  const seqs = (fo.length && yo.length)
    ? ` Field opens: ${fo.join(" > ")}. You open: ${yo.join(" > ")}.`
    : "";
  return [finding(DIM.ROTATION, INFO,
    `OPENER: ${lead}.${seqs} Match the field's opening sequence -- it sets up your whole first burst window.`,
    "measured", KIND.OPENER)];
}

// CD ALIGNMENT: you fire your major cooldowns scattered while the field stacks them into
// one multiplicative burst. A NAMED diagnostic, not a sized lever -- a sim won't price
// burst alignment and we haven't validated a DPS size on a behind-field character, so it
// carries INFO (impact 0). rotationFindings gated it to BEHIND-the-field, hero-matched
// peers, with a field stack-rate baseline (so a spec that correctly spreads its cooldowns
// never trips it), so a good player who bursts fine never reaches here. The fix is
// concrete: bunch your damage cooldowns into the same window.
function cdAlignLever(rot) {
  const a = rot && rot.cdAlign;
  if (!a) return [];
  return [finding(DIM.ROTATION, INFO,
    `CD ALIGNMENT: ${Math.round(a.you * 100)}% of your major-cooldown casts land within ~10s of another (vs the field's ${Math.round(a.field * 100)}%) -- the field bunches its cooldowns so the buffs overlap into one big burst; you spread yours out. ` +
    `Line your damage cooldowns up into the same window (and onto Bloodlust, if your group brings it) instead of pressing them whenever they come up.`,
    "measured", KIND.CD_ALIGN)];
}

// WEAK WINDOW: the stretch of the fight where your damage SHARE trails the field the most
// -- the SHAPE of your damage curve, which every rate/share/uptime aggregate misses (you
// can match the field on totals yet bleed one specific window). Field-measured, with the
// intermission guard built in (weakestWindow only counts bins where the field KEPT dealing
// damage), so a shared phase where the boss is untargetable never reads as your mistake.
// Sized as the share you'd recover by keeping pace there (a fraction of your own output).
function weakWindowLever(rot) {
  const w = rot && rot.weakWindow;
  if (!w) return [];
  const pct = Math.max(1, Math.round(w.lostFrac * 100));
  const fromP = Math.round(w.from * 100), toP = Math.round(w.to * 100);
  const k = (n) => `${Math.round(n / 1000)}k`;
  // NAME the phase. The curve is bucketed by fight TIME, so a window near 0% is your
  // OPENER and one near 100% is the EXECUTE/finish -- telling the player WHERE to look (and
  // the most likely cause there) turns a "20-40% stretch" riddle into an actionable fix.
  const phase = toP <= 33 ? "your opener" : fromP >= 66 ? "the fight's final stretch" : "the middle of the fight";
  const hint = toP <= 33
    ? "ramp up faster -- pre-pull your opener and get your cooldowns rolling from the first GCD"
    : fromP >= 66
    ? "don't coast to the finish -- you may be dumping resources/cooldowns too early or repositioning for the kill; keep pressing through the execute"
    : "find what stops you there (movement, a mechanic you disengage for, or a cooldown you're holding) and keep your uptime up";
  // The bracket label already carries the sizing (reconciled to your gap); restating a raw
  // "~N% of your total" here just fought it (a near-field player saw "[~2% DPS]" beside
  // "~5% of your total"). The concrete k-vs-k drop conveys the magnitude; lead with the fix.
  const Hint = hint.charAt(0).toUpperCase() + hint.slice(1);
  return [finding(DIM.ROTATION, DPS(pct),
    `DAMAGE TIMELINE: your ${throughputWord()} craters during ${phase} (${fromP}-${toP}% of the fight) -- ~${k(w.youDps)} vs your own ~${k(w.yourTypical)} across the rest of it, and it's not a shared break (the field holds ~${k(w.fieldDps)} there). ${Hint}.`,
    "measured", KIND.WEAK_WINDOW)];
}

// Assemble all rotation levers into the shared { dim, impact, label, text } currency.
// Each kind is its own pure (rot, link) -> Finding[] above; this just concatenates in
// priority order. Only a GENUINE under-used proc is actionable -- crit-driven big hits
// are deliberately NOT recommended (a big hit is usually just a crit).
export function rotationLevers(rot) {
  const ids = (rot && rot.abilityIds) || {};
  const link = (n) => wowheadSpell(ids[n], n);   // ability name -> Wowhead link when we have the id
  return [
    ...usageLevers(rot, link),
    ...cooldownLevers(rot, link),
    ...buffCdLevers(rot),
    ...petLever(rot),
    ...dotLevers(rot),
    ...empowermentLever(rot, link),
    ...openerLever(rot, link),
    ...cdAlignLever(rot),
    ...weakWindowLever(rot),
  ];
}

// CROSS-BOSS RECURRENCE. The tool's job is to teach you to play better across ALL your
// raiding, not to grade one kill. So we analyze your rotation on your benchmark boss AND
// up to a couple of OTHER recent bosses (each vs ITS OWN field -- cast rates aren't
// comparable across different fights, so we never average them; we compare LEVERS), then:
//   - a keyed lever that fires on the benchmark AND another boss is a CONSISTENT habit:
//     we annotate it so the player knows fixing it lifts every fight, not just this kill.
//   - a keyed lever that recurs on the OTHER bosses but NOT the benchmark is a habit the
//     benchmark kill happened to dodge: we surface it as an INFO note (impact 0) so it
//     NEVER disturbs the gap reconciliation (which is sized on the benchmark kill alone),
//     yet the player still sees the habit.
// `mainLevers` = rotationLevers(benchmark findings); `otherBosses` = [{ name, levers }]
// for each extra boss. Pure -> unit-testable; fail-soft callers pass only the bosses that
// loaded. Returns { levers, infos }: annotated main levers + the cross-boss-only INFO notes.
export function mergeRotationRecurrence(mainLevers, otherBosses = []) {
  const main = mainLevers || [];
  const others = (otherBosses || []).filter((o) => o && o.levers && o.levers.length);
  const totalBosses = 1 + others.length;
  // key -> set of bosses it fired on (the benchmark counts as "__bench__").
  const firedOn = new Map();
  const mark = (key, boss) => {
    if (!key) return;
    if (!firedOn.has(key)) firedOn.set(key, new Set());
    firedOn.get(key).add(boss);
  };
  for (const fnd of main) mark(fnd.recurKey, "__bench__");
  for (const o of others) for (const fnd of o.levers) mark(fnd.recurKey, o.name);

  // Annotate the benchmark levers that ALSO fire on >=1 other boss (a confirmed habit).
  const levers = main.map((fnd) => {
    if (!fnd.recurKey) return fnd;
    const on = firedOn.get(fnd.recurKey);
    const count = on ? on.size : 1;
    if (count < 2) return fnd;   // only the benchmark kill -> no recurrence claim
    const where = count === totalBosses
      ? (count === 2 ? "both recent bosses I checked" : `all ${count} recent bosses I checked`)
      : `${count} of the ${totalBosses} recent bosses I checked`;
    return { ...fnd, text: fnd.text +
      ` You do this on ${where} -- a consistent habit, so fixing it lifts every fight, not just this kill.` };
  });

  // The lever KINDS that recur across >=2 of the analyzed bosses (benchmark or not). A
  // benchmark-based "you do X well" strength (PRIORITY/COOLDOWNS/DOTS) is a CONTRADICTION
  // when the same kind recurs elsewhere -- prescribe uses this to suppress the false praise
  // (the benchmark can be your BEST-played boss). Prefix = the part before ":" (or the whole
  // key for singletons like "pet").
  const recurringKinds = new Set();
  for (const [key, on] of firedOn) {
    if (on.size < 2) continue;
    recurringKinds.add(key.includes(":") ? key.slice(0, key.indexOf(":")) : key);
  }

  // INFO notes for keyed habits that recur on the OTHER bosses (>=2 of them) but never
  // showed on the benchmark kill. One per ability is fight-specific noise; >=2 is a habit.
  // The KEY insight to convey: we sized your gap on a kill where this DIDN'T show (often
  // your best-played boss), so the habit is real but lives off that fight -- not a footnote.
  const mainKeys = new Set(main.map((fnd) => fnd.recurKey).filter(Boolean));
  const infos = [];
  const emitted = new Set();
  for (const o of others) {
    for (const fnd of o.levers) {
      const key = fnd.recurKey;
      if (!key || mainKeys.has(key) || emitted.has(key)) continue;
      const on = firedOn.get(key);
      const bosses = on ? [...on].filter((b) => b !== "__bench__") : [];
      if (bosses.length < 2) continue;
      emitted.add(key);
      infos.push(finding(DIM.ROTATION, INFO,
        `HABIT ACROSS FIGHTS: this didn't show on the kill we sized your gap on (so it's not in the % list above), ` +
        `but on ${bosses.join(" and ")} the same slip recurs -- ${fnd.text} Worth fixing raid-wide.`));
    }
  }
  return { levers, infos, recurringKinds };
}
