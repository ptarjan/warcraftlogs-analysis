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
  playerMetrics, ilvlPeers, mapLimit, median, bestKill,
  reportCore, playerAbilities, dotUptimes, petDamage, fightWindow, fightEvents, paginateEvents, f, DPS, finding, eventTable, runIsHealer, throughputWord,
} from "./core.js";
import { talentedAbilities, heroTreeOf } from "./talents.js";
import { wowheadSpell } from "./links.js";
import { spellTooltip } from "./wcl.js";

// --- pure, unit-tested helpers ----------------------------------------------

// Count "empowered" hits: those far above the ability's own median. Procs form
// a high cluster; baseline hits a low one -- a multiple of the median separates
// them with no hard-coded numbers, so it generalizes across classes.
export function empoweredCount(amounts, factor = 1.8) {
  if (amounts.length < 4) return 0;
  const s = [...amounts].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)] || 0;
  return amounts.filter((a) => a > med * factor).length;
}

export function openerSequence(casts, windowMs = 20000, n = 8) {
  if (!casts.length) return [];
  const t0 = casts[0].t;
  return casts.filter((c) => c.t - t0 <= windowMs).slice(0, n).map((c) => c.name);
}

// What FRACTION of an ability's casts land "empowered" -- the high-damage version
// of a bimodal hit (a Tiger Palm set up by its combo vs a bare one). Each player is
// measured against their OWN median, so it's comparable across gear: the empowered
// version is the minority that lands well above the routine (bare) hit, which sits
// at the median. A hit > `factor`x your median counts as empowered. Crits are
// EXCLUDED (a crit ~doubles any hit -- that's stats, not a missed button). Returns
// null with too few hits to judge. Lets us SHOW "you land X% empowered vs the
// field's Y%" and only claim an empowerment lever when your share actually trails --
// and because it's a within-player fraction, a flat amp (comp, or a boss's
// damage-taken debuff) lifts both clusters and leaves the share unchanged.
export function empoweredShare(nonCritAmounts, { minHits = 6, factor = 1.5 } = {}) {
  const s = [...nonCritAmounts].sort((a, b) => a - b);
  if (s.length < minHits) return null;
  const med = s[Math.floor(s.length / 2)];
  if (!(med > 0)) return null;
  return nonCritAmounts.filter((a) => a > med * factor).length / nonCritAmounts.length;
}

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
  return {
    count: s.length,
    med: s.length ? s[Math.floor(s.length / 2)] : 0,
    max: s.length ? s[s.length - 1] : 0,
    critPct: s.length ? (100 * crits) / s.length : 0,
    procBig: empoweredCount(nonCrit),   // outsized NON-crit hits = a real proc
    empShare: empoweredShare(nonCrit),  // fraction of casts that land empowered (null if too few)
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
    return { opener: openerSequence(casts), procPerMin, empShare, castRate, allCastRate, name2id,
             dmgBy: m.dmgBy, total: m.total, dur, sourceID: m.sourceID, dotUp, petShare };
  }

  // You: per-hit detail for the top damage abilities (bounded for API cost).
  const top = abils.slice(0, opts.topN || 4);
  const hits = [];
  for (const a of top) {
    const evs = await paginateEvents(code, fight, m.sourceID, eventTable(), a.guid, s, e);
    if (evs.length) {
      const ph = perHit(evs);
      hits.push({ name: a.name, ...ph, procPerMin: ph.procBig / (dur / 60 || 1) });
    }
  }
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
  return { opener: openerSequence(casts), hits, dur, castRate, allCastRate, dmgTotals, total: m.total,
           sourceID: m.sourceID, name2id, dots, dotUp, petShare };
}

// Median casts/min per ability across the field's kills (absent in a kill = 0),
// so one peer who weaves an off ability doesn't skew the "field rate".
export function fieldCastRates(peerRates) {
  if (!peerRates.length) return {};
  const names = new Set(peerRates.flatMap((r) => Object.keys(r)));
  const out = {};
  for (const n of names) out[n] = median(peerRates.map((r) => r[n] || 0));
  return out;
}

// Where your ability USAGE diverges from the field: `under` = abilities the field
// presses much more than you (a core spender or damage cooldown you're missing --
// e.g. pressing Raze where the field presses Ravage shows Ravage under + Raze
// over); `over` = abilities you press far more than the field (a wrong button).
// Class-agnostic: the target rates come entirely from the field. `floor` keeps
// out rarely-cast noise; `ratio` requires a real gap (default: 2x).
export function usageDivergence(youRate, fieldRate, { floor = 0.5, ratio = 2 } = {}) {
  const names = new Set([...Object.keys(youRate || {}), ...Object.keys(fieldRate || {})]);
  const under = [], over = [];
  for (const n of names) {
    const y = (youRate || {})[n] || 0, fl = (fieldRate || {})[n] || 0;
    if (fl >= floor && fl >= y * ratio && fl - y >= floor) under.push({ name: n, you: y, field: fl, gap: fl - y });
    if (y >= floor && y >= fl * ratio && y - fl >= floor) over.push({ name: n, you: y, field: fl, gap: y - fl });
  }
  under.sort((a, b) => b.gap - a.gap);
  over.sort((a, b) => b.gap - a.gap);
  return { under, over };
}

// Pick the peers to compare your rotation against. Prefer ones on your SAME hero
// tree (each peer carries `.hero`) -- two trees swap whole buttons, so a mixed
// field makes the cast-rate diff lie. Fall back to the whole field when your tree
// is unknown or too few peers share it (a noisy comparison beats none). Pure.
export function sameHeroPeers(analyzed, yourHero, min = 3) {
  if (!yourHero) return analyzed;
  const same = analyzed.filter((a) => a.hero === yourHero);
  return same.length >= min ? same : analyzed;
}

// Keep only over-press findings that are real ROTATION levers. An over-press is a
// rotation error only when the field ALSO presses the ability (just less) -- you
// can't "press it less" toward a field that presses it ~0 without dropping the
// talent, which is a BUILD/hero-tree difference, not a rotation fix (an Elune's
// Chosen Guardian "over-pressing" Thrash/Raze next to a Druid-of-the-Claw field
// that replaced them). Keep a near-zero field only when peers are hero-matched,
// where a zero genuinely means a wrong button within your own build. Pure.
export function realOveruse(over, heroMatched, floor = 0.5) {
  return (over || []).filter((a) => heroMatched || a.field >= floor);
}

// Under-used DAMAGE COOLDOWNS -- the lever usageDivergence structurally MISSES.
// usageDivergence floors at 0.5 casts/min (filler-tuned), but a damage cooldown is
// cast ~0.1-1.0/min, so a player skipping it is invisible there -- and that's
// exactly where a big PLAYSTYLE gap hides (gear/sims only move a few %; the gap at
// matched ilvl is HOW you play). Here we look in the cooldown band and size the
// gap from MEASURED damage: missed casts x your damage-per-cast / your total damage.
// Class-agnostic -- the cooldown set and rates come entirely from you + the field;
// only damage-dealing casts appear (castRate is built from the damage table), so a
// pure buff/summon CD won't show (that needs buff-uptime analysis, not cast counts).
export function cooldownGaps(youRate, fieldRate, dmgTotals, dur, { band = 1.0, minField = 0.1 } = {}) {
  const totalDmg = Object.values(dmgTotals || {}).reduce((a, b) => a + b, 0) || 1;
  const mins = dur ? dur / 60 : 0;
  const out = [];
  for (const [n, fr] of Object.entries(fieldRate || {})) {
    const yr = (youRate || {})[n] || 0;
    if (fr < minField || fr > band) continue;          // only the low-frequency cooldown band
    if (fr <= yr * 1.3 || fr - yr < 0.1) continue;     // you already use it about as much
    const youCasts = yr * mins, fieldCasts = fr * mins;
    // Size from your OWN damage-per-cast (robust to multi-hit; conservative if you
    // use it in worse windows than the field). Needs >=1 of your casts to measure.
    const dpc = youCasts >= 0.5 ? (dmgTotals[n] || 0) / youCasts : null;
    const pct = dpc != null ? Math.round((100 * (fieldCasts - youCasts) * dpc) / totalDmg) : null;
    out.push({ name: n, you: yr, field: fr, youCasts, fieldCasts, pct });
  }
  return out.sort((a, b) => (b.pct || 0) - (a.pct || 0));
}

// COOLDOWN USAGE gaps from ALL casts (keyed by ability id), the layer that catches
// BUFF/PET cooldowns the damage table can't see (Invoke Niuzao, Weapons of Order).
// We can't size a buff/pet CD's damage from cast counts, so this returns the
// measured USAGE gap (you vs field, per kill) -- a "the field presses this cooldown
// more than you" fact to NAME in the playstyle breakdown, not a fabricated %. Only
// the low-frequency band, and only a real gap (field >=1.5x you AND >=1 cast/kill
// more). Class-agnostic; names are resolved by the caller (Wowhead) for just these.
export function castUsageGaps(youRate, fieldRate, dur, { band = 1.5, minField = 0.3 } = {}) {
  const mins = dur ? dur / 60 : 1;
  const out = [];
  for (const [id, fr] of Object.entries(fieldRate || {})) {
    const yr = (youRate || {})[id] || 0;
    if (fr < minField || fr > band) continue;            // cooldown band only (skip fillers)
    if (fr < yr * 1.5 || (fr - yr) * mins < 1) continue; // real gap: >=1 more cast/kill
    out.push({ id, you: yr, field: fr, youPerFight: yr * mins, fieldPerFight: fr * mins, gap: fr - yr });
  }
  return out.sort((a, b) => b.gap - a.gap);
}

// Per-cast DAMAGE gaps vs the field, ABILITY-SPECIFIC -- the home of a big
// playstyle remainder that ISN'T a missing cast (you press the button as often as
// the field) but a WEAK one. When the field's same ability hits much harder per
// cast than yours AND by more than their OVERALL damage edge (the comp+stats
// baseline), only that ability is behind -- which can't be crit or comp (those
// lift everything ~evenly), so you're landing it OUTSIDE its empowerment window
// (the combo/buff/proc that powers your biggest hit -- e.g. an empowered Tiger
// Palm). Class-agnostic: the abilities, per-cast damage, and the baseline all come
// from the data; nothing about the spec is named. Sized by the ability-specific
// per-cast excess (above the comp/stats baseline) valued at YOUR cast count, then
// damped (single-kill crit RNG, and you can't empower 100% of casts).
//   yourAb:       name -> { total, casts } (your damage + cast count this fight)
//   fieldAb:      name -> median field damage-per-cast
//   overallRatio: field median total / your total (the comp+stats baseline)
export function perCastGaps(yourAb, fieldAb, overallRatio, yourTotal,
    { minCasts = 3, minRatio = 1.5, overFactor = 1.25, damp = 0.5 } = {}) {
  const out = [];
  const base = overallRatio > 0 ? overallRatio : 1;
  for (const [name, y] of Object.entries(yourAb || {})) {
    const fpc = fieldAb[name];
    if (fpc == null || !y.casts || y.casts < minCasts || !(y.total > 0)) continue;
    const youPC = y.total / y.casts;
    if (!(youPC > 0)) continue;
    const raw = fpc / youPC;
    // Must be a real gap (>=minRatio) AND ability-specific (clearly beyond the
    // overall edge) -- an ability merely riding the field's general advantage is
    // stats/comp, already covered elsewhere, not an empowerment lever.
    if (raw < minRatio || raw < base * overFactor) continue;
    const excessPC = Math.max(0, fpc / base - youPC);   // per-cast damage beyond the comp/stats baseline
    const pct = Math.round(damp * 100 * excessPC * y.casts / (yourTotal || 1));
    if (pct < 1) continue;
    out.push({ name, youPerCast: youPC, fieldPerCast: fpc, raw, pct });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

// Classify the field's top under-used ability against YOUR talents, so we only
// say "respec" when it's actually a talent you lack. `talent` is the
// { taken, universe } from talentedAbilities (or null when unknown).
//   - "talented-unused": you specced it but never press it -> build/usage problem
//   - "missing-talent":  it's a talent you skipped (peers run it) -> respec
//   - null:              baseline ability you simply aren't pressing (e.g. Shield
//                        of the Righteous), OR not a never-pressed case, OR no
//                        talent data -> handle as an ordinary rotation/priority fix
//                        (NEVER claim a missing talent we can't prove).
// DoT-uptime gaps: a DoT you keep up LESS than the field loses its damage roughly
// in proportion to the shortfall (its damage scales ~linearly with uptime). Pure ->
// testable. `share` = the DoT's fraction of YOUR total damage (measured); closing
// the gap scales that DoT up by field/you, so lost% = share*(field-you)/you*100.
// Only a REAL clip (>= minGap pp below the field) worth >=1% fires -- so a
// well-maintained DoT (uptime ~= the field) stays silent (no false positive).
export function dotUptimeGaps(dots, youUp, fieldUp, { minGap = 6, minFieldUptime = 70 } = {}) {
  const out = [];
  for (const d of (dots || [])) {
    const you = (youUp || {})[d.guid], field = (fieldUp || {})[d.guid];
    if (you == null || field == null) continue;
    // The field must actually MAINTAIN it. A channeled filler (Mind Flay) or a proc
    // also "ticks", but the field keeps it up only ~25% -- being below them there is
    // usage, not a clip. A real maintained DoT sits at high field uptime (SW:Pain
    // ~100%). Gate on that so "don't clip your DoT" is never said about a channel.
    if (field < minFieldUptime) continue;
    if (field - you < minGap) continue;
    const pct = Math.round((100 * (d.share || 0) * (field - you)) / Math.max(you, 1));
    if (pct < 1) continue;
    out.push({ name: d.name, guid: d.guid, you, field, pct });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

// Pet-share gap: a pet-heavy spec (Unholy DK, BM Hunter, Demo Lock) whose pets do
// LESS of its damage than the field's is leaving pet damage on the table -- poor
// summon/transform/Army timing, which cast/cooldown levers can't see. Pure ->
// testable, MEASURED. Closing the gap scales your OWN damage's complement up, so
// gain = (1-you)/(1-field). Gated: only a REAL pet spec (field pets >= 10% of damage
// -- excludes trinket-proc pets), and only below the field by a real margin -- so a
// non-pet spec (share ~0) and a player who matches the field stay silent.
export function petShareGap(youShare, fieldShare, { minGap = 0.05, minFieldShare = 0.10 } = {}) {
  if (youShare == null || fieldShare == null) return null;
  if (fieldShare < minFieldShare) return null;        // not a pet spec
  if (fieldShare - youShare < minGap) return null;    // you match/beat the field
  const pct = Math.round(100 * ((1 - youShare) / (1 - fieldShare) - 1));
  return pct >= 1 ? { you: Math.round(100 * youShare), field: Math.round(100 * fieldShare), pct } : null;
}

export function classifyUnderUse(top, talent) {
  if (!top) return null;
  const neverPress = top.you < 0.2 && top.field >= 1.5;
  if (!neverPress || !talent || !talent.universe) return null;
  if (talent.taken.has(top.name)) return "talented-unused";
  if (talent.universe.has(top.name)) return "missing-talent";
  return null;                              // baseline -> press it, don't respec
}

// Can the player actually cast this ability with the build they ran? True if they
// TALENTED it, or it's BASELINE (not in the spec's talent universe at all). False
// only for a talent they SKIPPED -- a different build (often the other hero tree).
// Guards the bug where the rotation peer pool skews to a different hero tree and we
// tell the player to "press <ability> more" for a button they can't cast (a Guardian
// on Elune's Chosen told to press Ravage, a Druid of the Claw talent). A genuinely
// skipped DAMAGE talent the whole field takes is surfaced separately as a RESPEC
// finding (classifyUnderUse), not as "press it more". Missing talent data -> keep
// it (can't prove a build mismatch, don't suppress a real fix).
export function castable(name, talent) {
  if (!talent || !talent.universe) return true;
  if (talent.taken.has(name)) return true;
  return !talent.universe.has(name);
}

// --- findings (data the prescription consumes) -------------------------------

// Returns structured rotation findings. The key output is `proc`: a genuine
// empowerment proc (outsized NON-crit hits) you under-use vs the field -- an
// actionable list item. If big hits are merely crits, proc.isReal is false and
// NOTHING is recommended (a "big hit" is usually a crit, not a missed button).
export async function rotationFindings(name, server, region, className, specName, difficulty) {
  // Analyze your most-recent current-gear kill (bestKill -- shared with gear /
  // talents / topparse, so the fetch is cached), not whatever boss you've farmed
  // most. Recent = current play, and a single full kill has plenty of casts.
  const best = await bestKill(name, server, region, difficulty);
  if (!best) return null;
  const boss = best.encounter;
  const you = await analyzeKill(name, best.code, best.fight, specName, className, { topN: 5 });
  // Don't bail on empty hits: a PET-heavy spec (Demonology Warlock) has PETS as its
  // top damage abilities, whose per-hit events live under the PET's sourceID -- so
  // `hits` (the empowerment/biggest-hit analysis) comes back empty. That analysis is
  // a BONUS; the usage/cooldown/DoT/pet/castGap levers don't need it. Bailing here
  // killed ALL rotation levers for Demo Lock. Make empowerment optional instead.
  if (!you) return null;

  // The empowerment candidate is your HARDEST hitter (biggest per-cast) -- the hit
  // whose strength matters most, and the one a missed buff/combo window most hurts.
  // We measure the FIELD's empowered share of THIS ability so "your big hit lands
  // weak" can only fire on real under-empowerment, never on a uniform stat gap.
  const biggest = you.hits.length ? [...you.hits].sort((a, b) => b.med - a.med)[0] : null;
  const isReal = biggest ? biggest.procBig >= 2 : false;   // null biggest -> no empowerment analysis

  // The ilvl-matched field, via the shared core.ilvlPeers (same set overview /
  // timeline / prescribe use, so the fetches dedupe). It feeds the empowered-share
  // + proc rate of your biggest hit, the opener, AND the ability-usage comparison.
  let cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName);
  // Under-geared, or a low-population spec: if NO ilvl-matched peers exist (everyone
  // logged is far higher ilvl), widen the window so we can still compare PLAYSTYLE.
  // Which buttons you press, pet usage, and DoT uptime are ~ilvl-independent, so a
  // slightly-higher-ilvl field is a valid rotation comparison -- and an approximate
  // one beats none (0 peers = no rotation levers + a uninformative remainder). The
  // raw-DPS gap stays strict (it's measured elsewhere against the tight ilvl band).
  if (!cands.length) cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName, { window: 15 });
  // Your hero tree, so we can compare you only to peers who run the SAME one --
  // two hero trees swap whole buttons, and a mixed field makes the cast-rate diff
  // lie in BOTH directions (you "over-press" a button the other tree dropped, and
  // "under-press" one it added). Best-effort; null -> compare to the whole field.
  let yourHero = null;
  try { yourHero = await heroTreeOf(best.code, best.fight, you.sourceID); } catch (e) { /* no talent data */ }
  const analyzed = (await mapLimit(cands, 4, async (r) => {
    try {
      const a = await analyzeKill(r.name, r.report.code, r.report.fightID, specName, className,
                                  { onlyAbility: biggest ? biggest.name : "__noempower__", dotIds: (you.dots || []).map((d) => d.guid) });
      if (!a) return null;
      const hero = yourHero ? await heroTreeOf(r.report.code, r.report.fightID, a.sourceID).catch(() => null) : null;
      return { ...a, hero };
    } catch (e) { return null; }
  })).filter(Boolean);
  const peers = sameHeroPeers(analyzed, yourHero).slice(0, 5);
  const fieldProc = (isReal && peers.length) ? median(peers.map((a) => a.procPerMin)) : null;
  // Field's empowered-cast share of your biggest hit (median over peers who had
  // enough hits to judge). Pairs with your own share to SHOW the comparison and to
  // gate the empowerment lever -- equal shares means the gap is per-cast stats, not
  // timing, so we stay silent.
  const empShares = peers.map((p) => p.empShare).filter((x) => x != null);
  const fieldEmp = (isReal && empShares.length >= 3) ? median(empShares) : null;
  const youEmp = biggest ? biggest.empShare : null;
  const fieldOpener = peers.length ? peers[0].opener : null;
  const fieldRate = fieldCastRates(peers.map((p) => p.castRate || {}));
  const usage = usageDivergence(you.castRate || {}, fieldRate);
  // Under-used damage cooldowns (the band usageDivergence's filler floor misses).
  // Dedupe against usage.under so the same ability isn't double-counted.
  const underNames = new Set(usage.under.map((a) => a.name));
  const cooldowns = (peers.length ? cooldownGaps(you.castRate || {}, fieldRate, you.dmgTotals || {}, you.dur) : [])
    .filter((c) => !underNames.has(c.name));
  // BUFF/PET cooldown usage gaps from ALL casts (the damage table can't see them).
  // Resolve names via Wowhead for just the top few divergent ids (bounded + cached).
  const fieldAllRate = fieldCastRates(peers.map((p) => p.allCastRate || {}));
  let cdUsage = [];
  if (peers.length) {
    const [fs, fe] = await fightWindow(best.code, best.fight);
    const yourTotal = you.total || Object.values(you.dmgTotals || {}).reduce((a, b) => a + b, 0) || 1;
    const gaps = castUsageGaps(you.allCastRate || {}, fieldAllRate, you.dur).slice(0, 5);
    cdUsage = (await mapLimit(gaps, 3, async (g) => {
      const id = Number(g.id);
      // Keep ONLY damage cooldowns YOU actually cast: a targeted DamageDone check
      // drops taunts/defensives/utility (Provoke, Fortifying Brew) and never-cast
      // talents (Empty the Cellar -- the talent lever's job) -- all deal no damage
      // under your source, so "use it on cooldown" can never be a false positive.
      // The same events SIZE the gap: missed casts x your damage-per-cast / total.
      let dmg = [];
      try { dmg = await paginateEvents(best.code, best.fight, you.sourceID, eventTable(), id, fs, fe); } catch (e) { return null; }
      if (!dmg.length) return null;
      let nm = null;
      try { const t = await spellTooltip(id); nm = t && t.name; } catch (e) { return null; }
      if (!nm || underNames.has(nm) || cooldowns.some((c) => c.name === nm)) return null;
      const abilityDmg = dmg.reduce((sm, x) => sm + (x.amount || 0), 0);
      const dpc = g.youPerFight >= 1 ? abilityDmg / g.youPerFight : null;
      const pct = dpc != null ? Math.round((100 * (g.fieldPerFight - g.youPerFight) * dpc) / yourTotal) : null;
      return { name: nm, youPerFight: g.youPerFight, fieldPerFight: g.fieldPerFight, id, pct };
    })).filter(Boolean).slice(0, 3);
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
    for (const h of you.hits) {
      const casts = (you.castRate[h.name] || 0) * yourMins;
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
    // Tag the biggest-hit's per-cast gap with the empowered-share comparison, so the
    // lever can decide WHY it's behind: a lower empowered share -> timing (empower
    // it more); equal shares -> uniform per-cast stats (leave it in the remainder).
    for (const pc of perCast) {
      if (biggest && pc.name === biggest.name) Object.assign(pc, { youEmp, fieldEmp });
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
  return {
    boss: boss.name, hits: you.hits, biggest, opener: you.opener, fieldOpener,
    usage, cooldowns, cdUsage, perCast, dotGaps, petGap, castGap, fieldPeers: peers.length, talent, abilityIds,
    heroMatched: yourHero && peers.length ? (peers.every((p) => p.hero === yourHero) ? yourHero : null) : null,
    proc: { name: biggest ? biggest.name : null, isReal, youPerMin: biggest ? biggest.procPerMin : 0, fieldPerMin: fieldProc, youEmp, fieldEmp },
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
  if (fnd.hits.length && fnd.biggest) {
    log("");
    log(`=== YOUR ${runIsHealer() ? "BIGGEST HEALS" : "HARDEST-HITTING ABILITIES"} (per cast) ===`);
    for (const h of [...fnd.hits].sort((a, b) => b.med - a.med))
      log(`  ${h.name.padEnd(20)} median ${Math.round(h.med).toLocaleString().padStart(8)}  ` +
          `max ${Math.round(h.max).toLocaleString().padStart(8)}  (${Math.round(h.critPct)}% crit, ` +
          `${h.procBig} non-crit big hits)`);
    log(`  -> biggest single-hit ability: ${fnd.biggest.name}`);
  }

  log("");
  if (!fnd.proc.isReal) {
    log("=== BIG HITS ARE CRIT-DRIVEN, NOT A PROC ===");
    log("  Your outsized hits are crits, not a missed empowerment button. More big");
    log("  hits = more crit + raid damage buffs (comp), not a rotation change.");
  } else {
    const p = fnd.proc;
    log(`=== EMPOWERMENT (${p.name}, high-damage casts) ===`);
    if (p.youEmp != null && p.fieldEmp != null) {
      log(`  empowered casts:  you ${Math.round(p.youEmp * 100)}%   peers ${Math.round(p.fieldEmp * 100)}%`);
      log(p.fieldEmp - p.youEmp >= 0.12
        ? "  -> Fewer than peers -- land your hardest hit in its empower/amp window more often."
        : "  -> About the same as peers. Your big hits land in their window as often; the per-cast gap is stats/comp/fight-amp, not timing.");
    } else {
      log(`  proc hits/min:  you ${p.youPerMin.toFixed(1)}   peers ${p.fieldPerMin == null ? "?" : p.fieldPerMin.toFixed(1)}`);
    }
  }

  log("");
  log("=== OPENER ===");
  log(`  your opener:  ${fnd.opener.join(" > ")}`);
  if (fnd.fieldOpener) log(`  peers' opener: ${fnd.fieldOpener.join(" > ")}`);

  const u = fnd.usage || { under: [], over: [] };
  // Only recommend pressing abilities you can actually cast -- the peer pool can
  // skew to a different hero tree and surface buttons your build doesn't have.
  const under = u.under.filter((a) => castable(a.name, fnd.talent));
  // Drop over-press findings that are really a hero-tree/build difference (you
  // press a button the field replaced) rather than a rotation error.
  const over = realOveruse(u.over, fnd.heroMatched);
  if (under.length || over.length) {
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

// Findings for prescribe.js (rotation domain): the actionable levers from
// rotationFindings() data as the shared { dim, impact, label, text } currency.
// Only a GENUINE under-used proc is actionable -- crit-driven big hits are
// deliberately NOT recommended (a big hit is usually just a crit). Pure.
export function rotationLevers(rot) {
  const out = [];
  const ids = (rot && rot.abilityIds) || {};
  const link = (n) => wowheadSpell(ids[n], n);   // ability name -> Wowhead link when we have the id
  // Biggest rotation lever: where your ability USAGE diverges from the field.
  // Pressing the wrong button (over-use one, never press the field's) or skipping
  // a cooldown is usually the largest gap for an underperformer -- sorts above
  // gear. Impact is an estimate (we can't sim it), sized by wrong-button vs under-use.
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
    if (cls === "missing-talent") {
      out.push(finding("Rotation", DPS(5, 10),
        `TALENTS/BUILD: you never press ${link(top.name)}, and you haven't talented it while the field casts it ` +
        `${f(top.field, 1)}/min -- respec to the field's build (the one with ${link(top.name)}); your rotation ` +
        `can't include it until you do.${onGlobals}`));
    } else if (cls === "talented-unused") {
      out.push(finding("Rotation", DPS(5, 10),
        `TALENTS/BUILD: you've talented ${link(top.name)} but never press it, while the field casts it ` +
        `${f(top.field, 1)}/min -- a wasted talent. Work it into your rotation, or respec the point into ` +
        `something you'll actually use.${onGlobals}`));
    } else {
      // Only recommend pressing abilities the player can actually cast -- the peer
      // pool can skew to a different hero tree (a Guardian on Elune's Chosen vs
      // Druid-of-the-Claw peers who press Ravage). A skipped damage talent the field
      // takes is the missing-talent branch above, not "press it more".
      const underAbilities = u.under.filter((a) => castable(a.name, rot && rot.talent));
      if (underAbilities.length) {
        const under = underAbilities.slice(0, 2).map((a) => `${link(a.name)} (peers ${f(a.field, 1)}/min vs your ${f(a.you, 1)})`);
        const wrongButton = realOver.length > 0;
        const over = wrongButton
          ? `; you over-press ${realOver.slice(0, 1).map((a) => `${link(a.name)} (your ${f(a.you, 1)}/min vs peers ${f(a.field, 1)})`).join("")}`
          : "";
        out.push(finding("Rotation", wrongButton ? DPS(5, 10) : DPS(3, 6),
          `ROTATION: press ${under.join(" and ")} more${over} -- match your peers' ability priority ` +
          `(verify in a log/sim).`));
      }
    }
  }
  // Under-used DAMAGE COOLDOWNS -- a measured PLAYSTYLE lever (the kind that
  // explains a big remainder; gear/sims don't). Sized from real damage-per-cast.
  // Two sources: cooldowns (the truncated damage table) and cdUsage (cast events,
  // which catch cooldowns beyond the top-5 the damage table shows). Dedupe by name.
  const seenCd = new Set();
  for (const cd of ((rot && rot.cooldowns) || []).slice(0, 2)) {
    if (cd.pct && cd.pct >= 1) {
      seenCd.add(cd.name);
      out.push(finding("Rotation", DPS(cd.pct),
        `COOLDOWN: you cast ${link(cd.name)} ${cd.youCasts.toFixed(1)}x this fight (${f(cd.you, 1)}/min) vs the field's ` +
        `${cd.fieldCasts.toFixed(1)}x (${f(cd.field, 1)}/min) -- ~${cd.pct}% of your ${throughputWord()}. Use it on cooldown ` +
        `(or line it up with your burst); it's a button you're skipping, not gear.`));
    }
  }
  for (const cd of ((rot && rot.cdUsage) || [])) {
    if (cd.pct && cd.pct >= 1 && !seenCd.has(cd.name)) {
      seenCd.add(cd.name);
      out.push(finding("Rotation", DPS(cd.pct),
        `COOLDOWN: you cast ${wowheadSpell(cd.id, cd.name)} ${cd.youPerFight.toFixed(0)}x/kill vs the field's ` +
        `${cd.fieldPerFight.toFixed(0)}x -- ~${cd.pct}% of your ${throughputWord()}. Use it on cooldown; it's a button you're ` +
        `skipping, not gear.`));
    }
  }
  // PET DAMAGE: a pet-heavy spec whose pets do less of its damage than the field's
  // is under-using its biggest hidden lever (summon/transform/Army timing). Measured.
  if (rot && rot.petGap) {
    const g = rot.petGap;
    out.push(finding("Rotation", DPS(g.pct),
      `PET ${throughputWord().toUpperCase()}: your pets do ${g.you}% of your ${throughputWord()} vs the field's ${g.field}% -- ~${g.pct}% behind. ` +
      `Use your pet cooldowns more: summon on cooldown, keep the pet active/transformed, and line up your ` +
      `big pet windows (Army/Gargoyle/burst). It's a major damage source you're under-using, not gear.`, "measured"));
  }
  // DoT UPTIME: a damage-over-time you keep up LESS than the field is lost damage
  // that cast/cooldown levers can't see -- THE missing lever for DoT specs. Measured
  // (boss uptime vs the field's), sized by the DoT's damage share x the shortfall.
  for (const d of ((rot && rot.dotGaps) || []).slice(0, 2)) {
    out.push(finding("Rotation", DPS(d.pct),
      `DOT UPTIME: your ${wowheadSpell(d.guid, d.name)} is up ${d.you}% on the boss vs the field's ${d.field}% ` +
      `-- ~${d.pct}% of your ${throughputWord()}. Refresh it before it falls off (don't clip or let it drop in movement); ` +
      `it's free ${throughputWord()} you already have the buttons for.`, "measured"));
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
  const emp = ((rot && rot.perCast) || []).find(
    (pc) => pc.youEmp != null && pc.fieldEmp != null && pc.pct >= 1 &&
            pc.fieldEmp >= 0.2 && pc.fieldEmp - pc.youEmp >= 0.12);
  if (emp) {
    out.push(finding("Rotation", DPS(emp.pct),
      `EMPOWERMENT: ${Math.round(emp.youEmp * 100)}% of your ${link(emp.name)} casts land in its high-damage window ` +
      `vs the field's ${Math.round(emp.fieldEmp * 100)}% -- your weak casts hit for roughly half. ` +
      `Line your hardest hit up with its empower window (its combo/buff/proc, or the boss's damage-taken window) every time.`,
      "measured"));
  }
  return out;
}
