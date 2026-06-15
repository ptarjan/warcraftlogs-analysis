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
  playerAbilities, dotUptimes, petDamage, fightWindow, fightEvents, paginateEvents, buffUptimes, f, DPS, finding, KIND, DIM, eventTable, runIsHealer, throughputWord,
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
  // Fight-relative cast timestamps per ability id -- kept (only for the "you" path)
  // so the buff-cooldown lever can size the damage uplift in the window after each
  // cast of an under-pressed buff WITHOUT re-fetching casts (they're already here).
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
  return { opener: openerSequence(casts), hits, dur, castRate, allCastRate, dmgTotals, total: m.total,
           sourceID: m.sourceID, name2id, dots, dotUp, petShare, castTimesById, dmgTimeline };
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
  /** @type {{name:string,you:number,field:number,gap:number,dmgPct?:number}[]} */
  const under = [];
  /** @type {{name:string,you:number,field:number,gap:number,dmgPct?:number}[]} */
  const over = [];
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

// The shared kernel of every "missed casts x your per-cast / total" sizer
// (cooldownGaps / usageDamageGaps / the cdUsage lever). Sizing from YOUR OWN
// damage-per-cast is deliberate: robust to multi-hit, and conservative (never claims
// the field's bigger hit -- the empowerment/per-cast levers own that, gated).
// perCastValue: total / casts, but only when you have >= min casts to divide by
// (else null -- too few to measure). dmgGapPct: the % of your throughput the casts
// you're MISSING are worth; null when per-cast is unmeasurable; optional cap so one
// ability can't dominate before reconcileImpacts. Pure -> testable.
export const perCastValue = (total, casts, min = 0.5) => (casts >= min ? (total || 0) / casts : null);
export const dmgGapPct = (missedCasts, perCast, total, cap = Infinity) =>
  perCast == null ? null : Math.min(cap, Math.round((100 * missedCasts * perCast) / (total || 1)));

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
    const dpc = perCastValue(dmgTotals[n], youCasts);
    const pct = dmgGapPct(fieldCasts - youCasts, dpc, totalDmg);
    out.push({ name: n, you: yr, field: fr, youCasts, fieldCasts, pct });
  }
  return out.sort((a, b) => (b.pct || 0) - (a.pct || 0));
}

// Size the UNDER-PRESSED damage abilities by MEASURED damage -- the way cooldownGaps
// sizes the low band, but for the filler/core band usageDivergence covers. Pressing a
// core ability far less than the field (Fury's Raging Blow 2.4/min vs 7.4) is the single
// biggest CONTROLLABLE lever for an underperformer, and -- flat-estimated until now --
// the chunk that hid in the "playstyle" residual. We size it from REAL damage so it
// lands as a concrete "press X more, ~N%" item instead of vanishing into the bucket.
// GCD-AWARE so it never over-claims: a wrong-button swap nets the per-cast DIFFERENCE
// (a GCD-capped player must drop a filler to fit the core ability -- displace the
// CHEAPEST over-pressed button first); a pure under-press (no over-press) nets the full
// hit, since the missing casts go into the idle time your lower cast rate proves you
// have. Sized from YOUR OWN per-cast damage -- never the field's bigger hit -- so it
// can't smuggle in a comp/crit gap (the empowerment/per-cast levers own that, gated).
// >=0.5 of your casts needed to measure a per-cast; a never-pressed ability has none and
// stays the (sim-priced) missing-talent branch. reconcileImpacts caps the column total
// at the gap, so a GCD-capped player with no detected over-press can't over-attribute.
// Returns { abilityName: pct }. Pure -> testable.
export function usageDamageGaps(under, over, dmgTotals, dur, total, { perCap = 30 } = {}) {
  const mins = dur ? dur / 60 : 0;
  if (!mins) return {};
  const totalDmg = total || Object.values(dmgTotals || {}).reduce((a, b) => a + b, 0) || 1;
  const dpc = (n, rate) => perCastValue(dmgTotals[n], rate * mins);
  // The cheapest over-pressed button's per-cast damage = what a GCD-capped swap
  // displaces. 0 when you over-press nothing (the extra casts are pure additions into
  // the idle GCDs your cast deficit implies). Subtracting it keeps the estimate
  // conservative (under-claims the pure-addition casts when both exist).
  const overDpcs = (over || []).map((o) => dpc(o.name, o.you)).filter((x) => x != null);
  const displaced = overDpcs.length ? Math.min(...overDpcs) : 0;
  const out = {};
  for (const u of (under || [])) {
    const dU = dpc(u.name, u.you);
    if (dU == null) continue;                          // can't measure -> talent branch owns it
    const net = Math.max(0, dU - displaced);           // GCD-aware net damage per recovered cast
    const missed = Math.max(0, (u.field - u.you) * mins);
    const pct = dmgGapPct(missed, net, totalDmg, perCap);
    if (pct >= 1) out[u.name] = pct;
  }
  return out;
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

// CAUSAL gate for a BUFF-COOLDOWN candidate: does casting it grant the PLAYER a
// self-buff aura? A real damage-buff cooldown (Weapons of Order, Recklessness,
// Avatar) applies an aura to YOU; a taunt/utility/defensive (Provoke, Fortifying
// Brew) does NOT. The windowed-damage uplift alone is CORRELATIONAL -- a taunt is
// pressed at pull/burst windows so your damage rises after it with nothing the
// ability did (the Provoke false positive). The self-buff aura is the CAUSAL
// signal: only an ability that buffs you can make your other damage hit harder.
// Match the cast id/name against the player's OWN self-buffs (a sourceID-filtered
// Buffs table -- core.buffUptimes, name -> { pct, guid }). Many CDs share the
// cast-id and the aura-id (Recklessness 1719, Avatar 107574) so match by id first;
// fall back to name (some apply an aura under a different spell id). Class-agnostic
// -- nothing about the ability is named; the signal is "did an aura land on you".
// Pure -> testable.
//   castId:    the candidate's cast ability id
//   castName:  the candidate's resolved name (may be null)
//   selfBuffs: core.buffUptimes result -- { name: { pct, guid } } of YOUR auras
export function selfBuffMatch(castId, castName, selfBuffs) {
  if (!selfBuffs) return false;
  const id = Number(castId);
  for (const [nm, info] of Object.entries(selfBuffs)) {
    if (id && info && Number(info.guid) === id) return true;        // aura-id == cast-id
    if (castName && nm && nm === castName) return true;             // same name fallback
  }
  return false;
}

// Windowed damage UPLIFT after each cast of one ability -- the SIZER for a buff
// cooldown (NOT the classifier; selfBuffMatch is the classifier, the causal gate).
// A pure buff (Weapons of Order, Recklessness, Avatar) has NO direct damage of its
// own, so the cast/cooldown levers (built from the damage table) can't size it. But
// a real damage buff makes EVERYTHING ELSE you do hit harder, so the player's OWN
// throughput in the N seconds after each cast rises above their baseline. Measuring
// that uplift sizes the buff's value (the in-window extra throughput). Used ONLY
// after the self-buff gate passes, so a utility cast that merely co-occurs with
// burst (the Provoke FP) never reaches here. Class-agnostic: nothing about the
// ability is named; the signal is the player's own damage timeline. Pure -> testable.
//   castTimes: ms timestamps of THIS ability's casts (fight-relative or absolute, any)
//   dmgEvents: ALL of the player's damage events, each { t, amount } (same time base)
//   window:    seconds after a cast to attribute to the buff
// Returns { uplift, inRate, baseRate, casts, windowSec } where uplift is the fractional
// rise of in-window throughput over the out-of-window baseline (0.3 = 30% more). The
// baseline EXCLUDES the windows themselves so a buff that's up most of the fight still
// shows a real contrast. null when there's too little to judge.
export function buffWindowUplift(castTimes, dmgEvents, { window = 8, minCasts = 2 } = {}) {
  const casts = (castTimes || []).filter((t) => t != null).sort((a, b) => a - b);
  if (casts.length < minCasts || !(dmgEvents || []).length) return null;
  const winMs = window * 1000;
  // Mark each event in/out of ANY cast's window, and accumulate covered time. Windows
  // can overlap (back-to-back casts); union the covered duration so rates are honest.
  let inDmg = 0, outDmg = 0;
  for (const ev of dmgEvents) {
    const t = ev.t, amt = ev.amount || 0;
    if (!(amt > 0)) continue;
    let covered = false;
    for (const c of casts) { if (t >= c && t < c + winMs) { covered = true; break; } if (c > t) break; }
    if (covered) inDmg += amt; else outDmg += amt;
  }
  // Union of [c, c+winMs] intervals -> total in-window seconds (clamped to the event span).
  const lo = dmgEvents[0].t, hi = dmgEvents[dmgEvents.length - 1].t;
  let inMs = 0, curS = null, curE = null;
  for (const c of casts) {
    const s = Math.max(c, lo), e = Math.min(c + winMs, hi);
    if (e <= s) continue;
    if (curS == null) { curS = s; curE = e; continue; }
    if (s <= curE) curE = Math.max(curE, e);
    else { inMs += curE - curS; curS = s; curE = e; }
  }
  if (curS != null) inMs += curE - curS;
  const totMs = hi - lo;
  const outMs = totMs - inMs;
  if (inMs <= 0 || outMs <= 0) return null;               // can't contrast (buff covers whole fight)
  const inRate = inDmg / (inMs / 1000);
  const baseRate = outDmg / (outMs / 1000);
  if (!(baseRate > 0)) return null;
  return { uplift: inRate / baseRate - 1, inRate, baseRate, casts: casts.length, windowSec: window };
}

// Size a missed BUFF cooldown from its MEASURED windowed uplift -- the sibling of
// cooldownGaps/petShareGap for a pure buff that deals no direct damage. The CAUSAL
// gate (selfBuffMatch) decides WHETHER this is a buff at all; this only sizes a
// candidate that ALREADY passed that gate. A castUsageGaps entry tells us how many
// casts you're MISSING vs the field; buffWindowUplift tells us how much extra
// throughput each cast's window is worth. The buff-attributable damage per cast is
// the in-window EXCESS over baseline (inRate-baseRate) x window seconds; each missed
// cast is that much throughput left on the table. % = missed x perCast / total.
// minUplift stays as a sanity floor (a self-buff that genuinely lifts ~nothing isn't
// worth a recommendation), but it is NOT the classifier -- the self-buff gate is.
// Pure -> testable.
//   gap:       a castUsageGaps entry { youPerFight, fieldPerFight, ... }
//   upl:       a buffWindowUplift result (or null)
//   yourTotal: your total damage this fight
export function buffCdGap(gap, upl, yourTotal, { minUplift = 0.08, minMissed = 1 } = {}) {
  if (!gap || !upl || !(yourTotal > 0)) return null;
  if (!(upl.uplift >= minUplift)) return null;            // self-buff that lifts ~nothing: not worth it
  const missed = (gap.fieldPerFight || 0) - (gap.youPerFight || 0);
  if (missed < minMissed) return null;                    // not really under-pressed
  const perCast = (upl.inRate - upl.baseRate) * upl.windowSec;  // buff-attributable dmg/cast
  if (!(perCast > 0)) return null;
  const pct = Math.round((100 * missed * perCast) / yourTotal);
  if (pct < 1) return null;
  return { missed, perCast, pct, uplift: upl.uplift,
           youPerFight: gap.youPerFight, fieldPerFight: gap.fieldPerFight };
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

// The ilvl-matched field for the rotation comparison, each peer analyzed the SAME way
// you were (analyzeKill), restricted to your hero tree. Via the shared core.ilvlPeers
// (same set overview / timeline / prescribe use, so fetches dedupe). If NO ilvl-matched
// peers exist (under-geared / low-pop spec), widen the window: which buttons you press,
// pet usage, and DoT uptime are ~ilvl-independent, so a slightly-higher-ilvl field is a
// valid PLAYSTYLE comparison and an approximate one beats none. Two hero trees swap whole
// buttons (a mixed field makes the cast-rate diff lie both ways), so we compare only to
// SAME-tree peers; hero detection is best-effort (null -> whole field). Returns the top 5.
async function fetchRotationPeers(name, server, region, boss, difficulty, className, specName, best, you, biggest) {
  let cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName);
  if (!cands.length) cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName, { window: 15 });
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
  return { peers: sameHeroPeers(analyzed, yourHero).slice(0, 5), yourHero };
}

// Returns structured rotation findings. The key output is `proc`: a genuine
// empowerment proc (outsized NON-crit hits) you under-use vs the field -- an
// actionable list item. If big hits are merely crits, proc.isReal is false and
// NOTHING is recommended (a "big hit" is usually a crit, not a missed button).
export async function rotationFindings(name, server, region, className, specName, difficulty, killOverride = null) {
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

  // The empowerment candidate is your HARDEST hitter (biggest per-cast) -- the hit
  // whose strength matters most, and the one a missed buff/combo window most hurts.
  // We measure the FIELD's empowered share of THIS ability so "your big hit lands
  // weak" can only fire on real under-empowerment, never on a uniform stat gap.
  const biggest = you.hits.length ? [...you.hits].sort((a, b) => b.med - a.med)[0] : null;
  const isReal = biggest ? biggest.procBig >= 2 : false;   // null biggest -> no empowerment analysis

  // The ilvl-matched field (peers analyzed the SAME way as you), restricted to your
  // hero tree. Feeds the empowered-share + proc rate of your biggest hit, the opener,
  // and the whole ability-usage comparison.
  const { peers, yourHero } = await fetchRotationPeers(
    name, server, region, boss, difficulty, className, specName, best, you, biggest);
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
  // Size each under-pressed damage ability by MEASURED damage (not a flat guess), so a
  // core ability you press far less than the field lands as a concrete %, not residual.
  const usageDmg = peers.length
    ? usageDamageGaps(usage.under, usage.over, you.dmgTotals || {}, you.dur, you.total)
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
    usage, cooldowns, cdUsage, buffCds, perCast, dotGaps, dotCount: (you.dots || []).length, petGap, castGap, fieldPeers: peers.length, talent, abilityIds,
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
        log(`  empowered casts:  you ${Math.round(p.youEmp * 100)}%   peers ${Math.round(p.fieldEmp * 100)}%`);
        log(p.fieldEmp - p.youEmp >= 0.12
          ? "  -> Fewer than peers -- land your hardest hit in its empower/amp window more often."
          : "  -> About the same as peers. Your big hits land in their window as often; the per-cast gap is stats/comp/fight-amp, not timing.");
      } else {
        log(`  proc hits/min:  you ${p.youPerMin.toFixed(1)}   peers ${p.fieldPerMin == null ? "?" : p.fieldPerMin.toFixed(1)}`);
      }
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
function usageLevers(rot, link) {
  const out = [];
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
    // never-pressed talent above is excluded. HEALERS: suppress -- "press more heals"
    // is a misframe (healing is reactive; casting into less damage just overheals).
    const underAbilities = runIsHealer()
      ? []
      : u.under.filter((a) => a.name !== consumed && castable(a.name, rot && rot.talent));
    const measured = underAbilities.filter((a) => (a.dmgPct || 0) >= 1).sort((a, b) => b.dmgPct - a.dmgPct);
    measured.slice(0, 3).forEach((a, i) => {
      // Name the wrong-button swap once, on the biggest, when you over-press a filler.
      const over = (i === 0 && realOver.length)
        ? ` You're spending those globals on ${link(realOver[0].name)} (your ${f(realOver[0].you, 1)}/min vs peers ${f(realOver[0].field, 1)}) -- swap them.`
        : "";
      out.push(finding(DIM.ROTATION, DPS(a.dmgPct),
        `ROTATION: press ${link(a.name)} more -- peers cast it ${f(a.field, 1)}/min vs your ${f(a.you, 1)}; ` +
        `the casts you're missing are ~${a.dmgPct}% of your ${throughputWord()}.${over}`, "measured"));
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
      out.push(finding(DIM.ROTATION, DPS(cd.pct),
        `COOLDOWN: you cast ${link(cd.name)} ${cd.youCasts.toFixed(1)}x this fight (${f(cd.you, 1)}/min) vs the field's ` +
        `${cd.fieldCasts.toFixed(1)}x (${f(cd.field, 1)}/min) -- ~${cd.pct}% of your ${throughputWord()}. Use it on cooldown ` +
        `(or line it up with your burst); it's a button you're skipping, not gear.`, "est", KIND.COOLDOWN));
    }
  }
  for (const cd of ((rot && rot.cdUsage) || [])) {
    if (cd.pct && cd.pct >= 1 && !seenCd.has(cd.name)) {
      seenCd.add(cd.name);
      out.push(finding(DIM.ROTATION, DPS(cd.pct),
        `COOLDOWN: you cast ${wowheadSpell(cd.id, cd.name)} ${cd.youPerFight.toFixed(0)}x/kill vs the field's ` +
        `${cd.fieldPerFight.toFixed(0)}x -- ~${cd.pct}% of your ${throughputWord()}. Use it on cooldown; it's a button you're ` +
        `skipping, not gear.`, "est", KIND.COOLDOWN));
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
      out.push(finding(DIM.ROTATION, DPS(b.pct),
        `BUFF COOLDOWN: you cast ${wowheadSpell(b.id, b.name)} ${b.youPerFight.toFixed(0)}x/kill vs the field's ` +
        `${b.fieldPerFight.toFixed(0)}x -- it buffs you, and your ${throughputWord()} rises ~${Math.round(b.uplift * 100)}% in the window after each cast, ` +
        `so missing it costs ~${b.pct}% of your ${throughputWord()}. Use it on cooldown (line it up with your burst); ` +
        `it's a buff you're skipping, not gear.`, "measured"));
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
    out.push(finding(DIM.ROTATION, DPS(g.pct),
      `PET ${throughputWord().toUpperCase()}: your pets do ${g.you}% of your ${throughputWord()} vs the field's ${g.field}% -- ~${g.pct}% behind. ` +
      `Use your pet cooldowns more: summon on cooldown, keep the pet active/transformed, and line up your ` +
      `big pet windows (Army/Gargoyle/burst). It's a major damage source you're under-using, not gear.`, "measured"));
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
    out.push(finding(DIM.ROTATION, DPS(d.pct),
      `DOT UPTIME: your ${wowheadSpell(d.guid, d.name)} is up ${d.you}% on the boss vs the field's ${d.field}% ` +
      `-- ~${d.pct}% of your ${throughputWord()}. Keep its uptime up: refresh it before it falls off (or, if it's ` +
      `auto-applied by your other casts/crits, keep those flowing), and don't let it lapse in movement -- that uptime is ~free ${throughputWord()}.`, "measured"));
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
    out.push(finding(DIM.ROTATION, DPS(emp.pct),
      `EMPOWERMENT: ${Math.round(emp.youEmp * 100)}% of your ${link(emp.name)} casts land in its high-damage window ` +
      `vs the field's ${Math.round(emp.fieldEmp * 100)}% -- your weak casts hit for roughly half. ` +
      `Line your hardest hit up with its empower window (its combo/buff/proc, or the boss's damage-taken window) every time.`,
      "measured", KIND.EMPOWERMENT));
  }
  return out;
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
  ];
}
