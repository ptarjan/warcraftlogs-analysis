// @ts-check
// Pure, class-agnostic rotation HELPERS, extracted from rotation.js: empowered-hit
// detection, opener / cooldown / usage / per-cast math, buff-window uplift, the weakest
// damage window. No network, no DOM -- every function here is unit-tested
// (test/rotation.test.mjs). rotation.js imports these and re-exports them, so external
// importers (the tests, prescribe.js) keep importing them from rotation.js unchanged.
import { median } from "./core.js";

// --- pure, unit-tested helpers ----------------------------------------------

// Count "empowered" hits: those far above the ability's own median. Procs form
// a high cluster; baseline hits a low one -- a multiple of the median separates
// them with no hard-coded numbers, so it generalizes across classes.
export function empoweredCount(amounts, factor = 1.8) {
  if (amounts.length < 4) return 0;
  const s = [...amounts].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  // A zero median (e.g. half the events are absorbed/immune 0s) would make `med * factor`
  // 0 and count EVERY positive hit as empowered -- mirror empoweredStats and bail.
  if (!(med > 0)) return 0;
  return amounts.filter((a) => a > med * factor).length;
}

export function openerSequence(casts, windowMs = 20000, n = 8) {
  if (!casts.length) return [];
  const t0 = casts[0].t;
  return casts.filter((c) => c.t - t0 <= windowMs).slice(0, n).map((c) => c.name);
}

// The field's CONSENSUS opener (for display): the modal ability at each opener
// position across peers, truncated at the first position where no ability holds a
// plurality -- past there the field genuinely diverges and there's no consensus to
// show. Replaces the brittle single-peer opener (peers[0]), which could showcase one
// outlier's pull as "the field's". Pure -> testable.
export function consensusOpener(openers, { minShare = 0.34, maxLen = 8 } = {}) {
  const live = (openers || []).filter((o) => o && o.length);
  if (!live.length) return null;
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    const at = live.map((o) => o[i]).filter(Boolean);
    if (!at.length) break;
    const counts = new Map();
    for (const nm of at) counts.set(nm, (counts.get(nm) || 0) + 1);
    const [name, c] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (c / live.length < minShare) break;        // no plurality here -> consensus ends
    out.push(name);
  }
  return out.length ? out : null;
}

// Where YOUR opener diverges from the field's: the field's consensus FIRST cast -- the
// opening cooldown they lead with -- that you delay or skip. The opener sets up your first
// burst window; leading with two fillers before your major cooldown (or never casting it
// in the opener) bleeds that window in a way the whole-fight cast-rate levers can't see
// (your per-minute rate is fine; the TIMING of the first cast is the loss). We key off the
// field's POSITION-0 mode only -- their primary opener -- so a mid-opener filler the field
// happens to share never reads as "you skipped it", and a split field (no consensus lead)
// stays silent. Fires when you cast that lead >= minPosGap globals late, or not at all in
// your opener. The caller gates this on being BEHIND the field + hero-matched + castability,
// so a good player who opens differently-but-fine never sees it. Pure -> testable.
//   youOpener:   your opener (ability names, in cast order)
//   peerOpeners: each peer's opener
export function openerDivergence(youOpener, peerOpeners, { minShare = 0.6, minPosGap = 2, minPeers = 3 } = {}) {
  const live = (peerOpeners || []).filter((o) => o && o.length);
  if (live.length < minPeers || !(youOpener || []).length) return null;
  // The field's consensus opening cast = the mode of position 0 across peers.
  const firsts = new Map();
  for (const o of live) firsts.set(o[0], (firsts.get(o[0]) || 0) + 1);
  const [lead, c] = [...firsts.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = c / live.length;
  if (share < minShare) return null;              // no field-wide opening cast to compare to
  const at = youOpener.indexOf(lead);
  if (at === 0) return null;                       // you lead with it too -> opening fine
  const omitted = at < 0;
  if (!omitted && at < minPosGap) return null;     // you cast it ~as early -> not a real delay
  return { ability: lead, peerShare: share, peerPos: 0, youPos: omitted ? null : at, omitted, delay: omitted ? Infinity : at };
}

// An actor's MAJOR cooldowns from its all-casts rate: the low-frequency band (a cooldown
// is pressed ~0.15-1.5x/min; fillers are many/min). Class-agnostic -- the set comes
// entirely from the cast rates, no hard-coded ability names. Keyed by ability id (so it
// includes the buff/pet cooldowns the damage table can't see). Pure -> testable.
export function majorCooldownIds(allCastRate, { lo = 0.15, hi = 1.5 } = {}) {
  const out = [];
  for (const [id, r] of Object.entries(allCastRate || {})) if (r >= lo && r <= hi) out.push(id);
  return out;
}

// What fraction of an actor's major-cooldown CASTS are STACKED -- fired within `window`
// seconds of a DIFFERENT major cooldown, so their buffs overlap into one multiplicative
// burst. The within-actor signal the cast-COUNT levers (usage/cooldownGaps) can't see:
// you can press every cooldown the right NUMBER of times yet scatter them so they never
// compound. castTimesById: id -> [ms]; cdIds: this actor's major cooldowns. null when
// there are too few cooldowns or casts to judge (a lone cooldown can't stack; a handful
// of casts gives a coarse, noisy fraction). Pure -> testable.
export function cooldownStackFraction(castTimesById, cdIds, { window = 10, minCds = 2, minCasts = 4 } = {}) {
  const ids = (cdIds || []).filter((id) => ((castTimesById || {})[id] || []).length);
  if (ids.length < minCds) return null;
  const winMs = window * 1000;
  const casts = [];
  for (const id of ids) for (const t of castTimesById[id]) casts.push({ t, id });
  casts.sort((a, b) => a.t - b.t);
  if (casts.length < minCasts) return null;
  let stacked = 0;
  for (let i = 0; i < casts.length; i++) {
    const c = casts[i];
    let near = false;
    for (let j = i - 1; j >= 0 && c.t - casts[j].t <= winMs; j--) if (casts[j].id !== c.id) { near = true; break; }
    if (!near) for (let j = i + 1; j < casts.length && casts[j].t - c.t <= winMs; j++) if (casts[j].id !== c.id) { near = true; break; }
    if (near) stacked++;
  }
  return stacked / casts.length;
}

// CD-ALIGNMENT gap: you stack your major cooldowns LESS than the field does. The field
// baseline is the causal protection -- a spec where spreading cooldowns is correct shows a
// LOW field fraction too, so we only fire when same-spec, same-hero peers genuinely bunch
// theirs and you don't. The caller gates on being BEHIND + hero-matched and surfaces it as
// a NAMED diagnostic (no DPS size -- a sim won't price burst alignment, and the sized
// version awaits live-validation on a behind-field char). Pure -> testable.
export function cooldownStackGap(youFrac, fieldFracs, { minGap = 0.2, minPeers = 3 } = {}) {
  if (youFrac == null) return null;
  const fs = (fieldFracs || []).filter((x) => x != null);
  if (fs.length < minPeers) return null;
  const field = median(fs);
  if (field - youFrac < minGap) return null;          // you stack ~as much (or more) -> fine
  return { you: youFrac, field };
}

// Guard for CD-ALIGNMENT: only trust the SCATTER signal when you press your cooldowns about
// as OFTEN as the field. If you cast far fewer, a low stack fraction is a mechanical artifact
// of having fewer casts to co-occur -- that's the cooldown-USAGE lever's story (use it more),
// not alignment (bunch them). Aggregate major-cooldown cast rate, you vs field median. Pure.
export function cooldownUseComparable(youRate, fieldRates, { minRatio = 0.6, minPeers = 3 } = {}) {
  const fs = (fieldRates || []).filter((x) => x > 0);
  if (fs.length < minPeers || !(youRate > 0)) return false;
  return youRate >= minRatio * median(fs);
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
// {share, empowered, total} for an ability's non-crit casts, or null if too few to
// judge. `empowered`/`total` are concrete COUNTS so a lever can say "you land it
// empowered 41/78 times vs the field's ~62/78" instead of only a percentage.
export function empoweredStats(nonCritAmounts, { minHits = 6, factor = 1.5 } = {}) {
  const s = [...nonCritAmounts].sort((a, b) => a - b);
  if (s.length < minHits) return null;
  const med = s[Math.floor(s.length / 2)];
  if (!(med > 0)) return null;
  const empowered = nonCritAmounts.filter((a) => a > med * factor).length;
  return { share: empowered / nonCritAmounts.length, empowered, total: nonCritAmounts.length };
}

export function empoweredShare(nonCritAmounts, opts = {}) {
  const st = empoweredStats(nonCritAmounts, opts);
  return st ? st.share : null;
}

// Pick the ability whose EMPOWERMENT we measure against the field. If your hardest-median
// hit is ITSELF bimodal (a real empowered-vs-bare cluster), THAT is the empowerment ability
// and we keep it -- the original, validated choice (Brewmaster's Tiger Palm: median 71k, max
// 593k, 7 big non-crit hits). We only switch when that hardest hit is UNIFORM (no empowered
// cluster -- Frost's Ray of Frost, 0 big hits): then the median pick analyzes nothing useful,
// while the real loss hides in a low-median bimodal FILLER (Ice Lance into Shatter). For that
// case take the highest-VOLUME ability with a bimodal distribution (procBig>=2 + a measurable
// empShare). Changing ONLY the previously-dead case keeps every validated spec intact.
// Class-agnostic: it's the spec's "only good when empowered" button, whatever it's named.
/** @param {any[]|null|undefined} hits @param {Record<string,number>|null|undefined} [dmgTotals] @param {any} [biggest] */
export function empowermentCandidate(hits, dmgTotals, biggest = null) {
  if (biggest && biggest.empShare != null && biggest.procBig >= 2) return biggest;   // already the empowered hit
  const cands = (hits || []).filter((h) => h.empShare != null && h.procBig >= 2);
  if (!cands.length) return biggest;
  const tot = dmgTotals || {};
  return [...cands].sort((a, b) => (tot[b.name] || 0) - (tot[a.name] || 0))[0];
}

// Your damage RATE (DPS) per fight-PROGRESS bin (default deciles): damage dealt in each
// 1/bins slice of the fight, divided by that slice's seconds. Bucketing by fight PROGRESS
// (not absolute seconds) makes it comparable across kills of different length; using a RATE
// (not a share) makes it comparable in level so an absolute "you trail the field here" read
// works whether you're ahead or behind overall. null if no data.
export function damageCurve(events, start, durMs, bins = 10) {
  if (!(durMs > 0) || !(events && events.length)) return null;
  const binSec = durMs / bins / 1000;
  const d = new Array(bins).fill(0); let any = false;
  for (const ev of events) {
    const f = (ev.timestamp - start) / durMs;
    if (f < 0 || f >= 1) continue;
    d[Math.min(bins - 1, Math.floor(f * bins))] += ev.amount || 0; any = true;
  }
  return any ? d.map((v) => v / binSec) : null;
}

// Your single WEAKEST stretch: the contiguous fight-progress window where YOUR DPS craters
// below YOUR OWN typical level -- while the field does NOT dip there. Keying off your own
// baseline (not the field's level) is what makes it the right read for an ahead OR behind
// player: it finds a DISCRETE hole where you fell off your normal output, not "the top burst
// harder than you everywhere" (which an absolute-vs-top comparison wrongly flags as the
// opener). The field is the INTERMISSION GUARD only: a bin counts solely when the field is
// still ACTIVE there (>= minActive of the field's own typical), so a phase the field also
// sits out (boss untargetable) is the boss, not you. The realistic recovery target is your
// OWN typical (proven elsewhere in the fight). DEATH GUARD: a bin where you were DEAD (a
// death landed at/before it and you never recovered output) is NOT a rotation hole -- you
// can't press buttons while dead; that's a SURVIVAL finding, surfaced elsewhere. `deaths`
// (fight-progress fractions 0-1) excludes those bins, so a player who died mid-fight and
// stayed down doesn't get told to "keep your uptime" across the half they spent on the floor.
//
// TWO reference frames, kept distinct: DETECTION is own-baseline (a bin is a candidate hole
// only where you dropped below YOUR typical -- that's what keeps a uniformly-behind player
// from having their whole fight flagged). But SIZING is FIELD-relative: lostFrac is the
// window's share of your gap TO THE FIELD (sum of field-minus-you over the window / your
// total), because that is the number that must add up to the measured field gap. Sizing it
// vs your own typical was the bug -- it's a different denominator than the gap, so it
// over-counted for a player who's near/ahead of the field on net (they lose vs their own
// ceiling in one window but make it up elsewhere, so only the field-deficit is gainable
// toward the gap). Returns { from, to, youDps, yourTypical, fieldDps, lostFrac }.
/** @param {number[]|null|undefined} youCurve @param {(number[]|null|undefined)[]|null|undefined} fieldCurves @param {{minDrop?:number,minActive?:number,minPeers?:number,deaths?:number[]}} [opts] */
export function weakestWindow(youCurve, fieldCurves, { minDrop = 0.4, minActive = 0.5, minPeers = 3, deaths = [] } = {}) {
  if (!youCurve || !fieldCurves || fieldCurves.length < minPeers) return null;
  const bins = youCurve.length;
  const median = (a) => { const x = [...a].sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : 0; };
  const fieldMed = youCurve.map((_, i) => median(fieldCurves.map((c) => (c && c[i]) || 0)));
  const yourTypical = median(youCurve), fieldTypical = median(fieldMed);
  if (!(yourTypical > 0) || !(fieldTypical > 0)) return null;
  // You were DEAD in bin i if a death landed at/before its start AND you're still near-zero
  // there (you never got rezzed back to real output -- a recovered bin reads high and is kept).
  const deadIn = (i) => (deaths || []).some((d) => d <= i / bins) && youCurve[i] < yourTypical * 0.1;
  // ELIGIBLE = a candidate hole bin: you dropped well below YOUR OWN typical (the discrete-hole
  // detector) AND the field is still going (not a shared intermission) AND you weren't dead.
  const elig = youCurve.map((y, i) => !deadIn(i) && y < yourTypical * (1 - minDrop) && fieldMed[i] >= fieldTypical * minActive);
  // Per-bin contribution to the FIELD gap: how far you trail the field there (0 if you're
  // ahead of the field in that bin -- closing it wouldn't shrink your gap, it'd extend a lead).
  const gapBin = youCurve.map((y, i) => elig[i] ? Math.max(0, fieldMed[i] - y) : 0);
  let best = null, bestSum = 0, rs = -1, sum = 0;
  for (let i = 0; i <= bins; i++) {
    const pos = i < bins && elig[i];
    if (pos && rs < 0) { rs = i; sum = 0; }
    if (pos) sum += gapBin[i];
    if (!pos && rs >= 0) {
      if (!best || sum > bestSum) {
        let yd = 0, fd = 0; for (let j = rs; j < i; j++) { yd += youCurve[j]; fd += fieldMed[j]; }
        best = { from: rs / bins, to: i / bins, youDps: yd / (i - rs), yourTypical, fieldDps: fd / (i - rs) };
        bestSum = sum;
      }
      rs = -1;
    }
  }
  // bestSum <= 0 means your own-baseline hole is a spot you're actually AT/ABOVE the field --
  // real vs your ceiling, but NOT a gap to the field, so it's not a lever here.
  if (!best || !(bestSum > 0)) return null;
  const youTot = youCurve.reduce((a, b) => a + b, 0);
  return { ...best, lostFrac: youTot > 0 ? bestSum / youTot : 0 };   // window's share of your FIELD gap
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

// Per-ability MEDIAN cast rate across several of YOUR recent kills of the boss, so the
// under-press / press-faster comparison reflects how you TYPICALLY play it -- not one
// pull's noise (a kill where you happened to spam the wrong button). Union of every
// ability seen; a kill that didn't cast one counts it as 0 (you genuinely skipped it
// that pull), and damageAbilities is the FULL sourceID-filtered table (not the truncated
// top-5), so an ability you pressed shows up for every kill you pressed it. One kill (or
// none) -> just that kill's rates, unchanged. Pure -> testable.
export function medianCastRates(rates) {
  const live = (rates || []).filter(Boolean);
  if (live.length <= 1) return live[0] || {};
  const names = new Set();
  for (const r of live) for (const k of Object.keys(r)) names.add(k);
  const out = {};
  for (const n of names) out[n] = median(live.map((r) => r[n] || 0));
  return out;
}

// Where your ability USAGE diverges from the field: `under` = abilities the field
// presses much more than you (a core spender or damage cooldown you're missing --
// e.g. pressing Raze where the field presses Ravage shows Ravage under + Raze
// over); `over` = abilities you press far more than the field (a wrong button).
// Class-agnostic: the target rates come entirely from the field. `floor` keeps
// out rarely-cast noise; `ratio` requires a real gap (default: 2x).
//
// SECOND under-band (`bigGap`/`midRatio`): the 2x ratio gate STRUCTURALLY misses a
// "slow rotation" -- a player who casts EVERY core button ~1.5-1.6x below the field
// (Demonology pressing Hand of Gul'dan 22/min vs 34, Shadow Bolt 14 vs 23) trips no
// single 2x gap, so the whole deficit silently became the PLAYSTYLE remainder instead
// of a named "press this more" lever. So ALSO flag an ability the field out-casts by a
// LARGE absolute margin (>= bigGap casts/min) at a real proportional gap (>= midRatio),
// even below 2x. This only ADMITS candidates; the caller still sizes them by MEASURED
// damage-per-cast (usageDamageGaps) and drops any worth < 1% -- so a high-volume cheap
// FILLER cast slightly less never survives, only a core button worth real damage does.
export function usageDivergence(youRate, fieldRate, { floor = 0.5, ratio = 2, bigGap = 3, midRatio = 1.4 } = {}) {
  const names = new Set([...Object.keys(youRate || {}), ...Object.keys(fieldRate || {})]);
  /** @type {{name:string,you:number,field:number,gap:number,dmgPct?:number}[]} */
  const under = [];
  /** @type {{name:string,you:number,field:number,gap:number,dmgPct?:number}[]} */
  const over = [];
  for (const n of names) {
    const y = (youRate || {})[n] || 0, fl = (fieldRate || {})[n] || 0;
    const isUnder = (fl >= floor && fl >= y * ratio && fl - y >= floor)        // 2x gap (any size)
      || (fl - y >= bigGap && fl >= y * midRatio);                             // big absolute gap, sub-2x
    if (isUnder) under.push({ name: n, you: y, field: fl, gap: fl - y });
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
export function usageDamageGaps(under, over, dmgTotals, dur, total,
  { perCap = 30, benchRate = /** @type {Record<string,number>|null} */ (null) } = {}) {
  const mins = dur ? dur / 60 : 0;
  if (!mins) return {};
  const totalDmg = total || Object.values(dmgTotals || {}).reduce((a, b) => a + b, 0) || 1;
  // Per-cast DAMAGE rides on the benchmark kill's own cast count (benchmark damage /
  // benchmark casts) when given; the `rate` passed in (a cross-kill median) is only the
  // usage-deficit measure, so falling back to it would mix the two and mis-scale per-cast.
  const dpc = (n, rate) => perCastValue(dmgTotals[n], (benchRate && benchRate[n] != null ? benchRate[n] : rate) * mins);
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
    if (pct != null && pct >= 1) out[u.name] = pct;
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
  let inMs = 0, curS = -1, curE = -1;     // -1 = no open interval (timestamps are >= 0)
  for (const c of casts) {
    const s = Math.max(c, lo), e = Math.min(c + winMs, hi);
    if (e <= s) continue;
    if (curS < 0) { curS = s; curE = e; continue; }
    if (s <= curE) curE = Math.max(curE, e);
    else { inMs += curE - curS; curS = s; curE = e; }
  }
  if (curS >= 0) inMs += curE - curS;
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