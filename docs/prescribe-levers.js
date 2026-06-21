// @ts-check
// The cross-cutting prescription LEVER builders prescribe assembles from its own peer
// aggregates: execution (idle/latency/uptime), consumables, enchants, trinkets, the stat
// gap. Each returns Finding[] via DPS/INFO + finding(); trinketLevers fetches item data.
// Extracted from prescribe.js to keep it focused on fetch + reconcile + render.
import { f, topEntry, DPS, INFO, finding, KIND, DIM, runIsHealer, runIsSupport } from "./core.js";
import { itemInstance, sourceText } from "./gear.js";
import { wowheadSpell, wowheadItem } from "./links.js";
import { CONSUMABLES } from "./prescribe-helpers.js";

// --- cross-cutting levers prescribe builds from its OWN peer aggregates ------
// (gear/rotation/comp levers live in their domain modules; these need data only
// prescribe gathers: cross-boss execution, field consumables/enchants, stat gap.)
// Each returns Finding[].

// GCD overshoot (ms past the global) THIS much above the field reads as a real,
// coachable input-latency delay rather than reaction-time jitter. Set high on purpose:
// the only FIXABLE causes are a non-default spell-queue window (SQW defaults to AND
// caps at 400ms, so you can only raise it TO 400 -- never to "300") and world latency.
// A few tens of ms over the elite field is normal variance you can't act on, so a 30ms
// floor flagged near-optimal players (a 94th-pct caster at +76ms) with a 2% "fix" that
// isn't one. Only call it out when it's materially beyond that.
const LATENCY_MS = 100;

// How many percentage points of priority-stat SHARE you must beat the field by before
// we treat you as "already over-stacked" on it (suppress over-stacking recrafts + let
// the "well itemized" strength stand). A small margin would fire on noise; 5pp is a
// clear "you run meaningfully more of this stat than the field does" signal.
export const ABOVE_FIELD_MARGIN = 5;

// A field delta above this % is small-sample confounding (a niche high-ilvl field), not the
// consumable's value -> distrust it and fall back to the est. Matches the gear lever's 5%
// per-swap cap (statScore/statValueScore), so setup items stay comparable.
const CONS_MAX_PCT = 5;

// Input/queue latency: a high GCD overshoot vs peers means a delay after EVERY
// global before your next cast fires -- world latency, no spell-queue window, or
// reaction time. Tiny per-GCD but it's every GCD, so it compounds over a fight.
// Distinct from press-faster (idle gaps): this is the cast firing late, not not
// pressing. For a clean player (e.g. a caster who never moves) it's often the
// single biggest thing they actually control.
export function latencyLever(execd) {
  if (!execd || !(execd.overshootExcess >= LATENCY_MS)) return [];
  return [finding(DIM.EXECUTION, DPS(1, 3),
    `INPUT LATENCY: your cast fires ~${f(execd.overshootExcess, 0)}ms later than peers after every GCD -- a delay that compounds over a fight. ` +
    `Set your spell-queue window to its max (/console SpellQueueWindow 400 -- the default and the cap, never lower it), cut world latency (closer realm, wired connection), and pre-press your next ability so it queues the instant the GCD ends.`)];
}

/** @param {any} execd @param {any} rot @param {number|null} [peerGapPct] @param {number|null} [activePct] */
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
    // "(the rest is the rotation fix)" only holds when there IS a rotation fix -- i.e.
    // you under-press something (the deficit splits into raw speed + that fix). When
    // the deficit is ENTIRELY raw speed (no under-pressed ability, underGap 0), there
    // is no "rest" and no rotation item to point at -- don't reference one (Mazaltoff:
    // 71 vs 88 casts/min, no under-use).
    const hasRotationFix = under.length > 0;
    const cite = (cg && cg.field > 0 && (speedPct >= 3 || cg.you < cg.field))
      ? (speedPct >= 3
          ? ` You cast ${f(cg.you, 0)} damaging abilities/min vs the field's ${f(cg.field, 0)} -- ~${speedPct}% of that is raw speed${hasRotationFix ? " (the rest is the rotation fix above)" : ""}; the % here estimates the DPS it's worth.`
          : ` (Your lower cast rate -- ${f(cg.you, 0)} vs ${f(cg.field, 0)}/min -- is ${hasRotationFix ? "mostly the rotation fix above, not raw speed" : "a small raw-speed gap"}.)`)
      : "";
    const cause = latencyHigh
      ? "gaps between GCDs (partly input latency -- see the INPUT LATENCY item)."
      : "not latency (yours matches theirs), just gaps between GCDs.";
    // Only claim "you idle MORE" when you measurably do (pressExcess positive). When
    // the lever fired on the cast deficit while your in-range idle MATCHES the field
    // (pressExcess ~0), the gap is micro-gaps between GCDs, not big pauses -- say that
    // instead of printing a ~0s/min (or contradictory negative) idle figure.
    const headline = execd.pressExcess >= 0.5
      ? `PRESS FASTER (every boss): you idle ~${f(execd.pressExcess, 1)}s/min MORE than peers while in range and not moving -- ${cause}${cite} Queue your next ability so no GCD sits empty.`
      : `PRESS FASTER (every boss): your damaging-cast rate trails the field even though your in-range idle matches theirs -- ${cause}${cite} Tighten the gaps so each global fires the moment it's ready.`;
    out.push(finding(DIM.EXECUTION, DPS(pct), headline, "measured", KIND.PRESS_FASTER));
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
    out.push(finding(DIM.EXECUTION, DPS(Math.round(Math.max(execd.rangeExcess, 0.1) / 60 * 100)),
      `MOVEMENT (specific fights): you lose ~${f(execd.rangeExcess, 1)}s/min of casting to movement / being out of range vs peers (intermissions excluded).${where} Pre-position and cut avoidable movement to keep your GCD rolling.`, "measured", KIND.MOVEMENT));
  }
  return out;
}

export function consumableLevers(field, my) {
  const out = [];
  for (const cn of CONSUMABLES) {
    const counter = field[cn.field];
    if (!counter.size) continue;
    const top = topEntry(counter)[0];                        // field's most common, by count
    const mineName = my[cn.mine], mineGuid = my[cn.mine + "Guid"];
    // Prefer the MEASURED field delta (peers with it vs without) when the field
    // gives a counterfactual; else the category estimate. Both flagged honestly.
    // BUT a consumable is a small UNIVERSAL buff -- it can't plausibly give > a few %.
    // From a small/confounded field (a niche high-ilvl spec: ~9 peers) the measured
    // delta is small-sample CONFOUNDING ("13% DPS flask, n=4/5" -- better players just
    // flask AND play better), not the consumable's value. Above the same 5% ceiling the
    // gear lever caps swaps at, distrust it: fall back to the est + drop the cite. Keeps
    // the "measured floor" for the normal small deltas it's meant for.
    const trust = (d) => d && Math.round(d.pct) <= CONS_MAX_PCT ? d : null;
    const fdRaw = field.deltas && field.deltas[cn.field];
    const fd = trust(fdRaw);
    const noneScore = fd ? DPS(Math.round(fd.pct)) : cn.none;
    const basis = fd ? "measured" : "est";
    const cite = fd ? ` (measured: peers with it do ${Math.round(fd.pct)}% more, n=${fd.nHave}/${fd.nNot})` : "";
    if (!mineName) {
      // Same rule as the swap path below: don't list a consumable the field MEASURED
      // at ~0% benefit. "[~0% DPS] use a potion (peers gain 0%) -- free parse" is
      // self-contradicting noise (and reconcileImpacts gives a 0% item nothing). An
      // UNMEASURED (est) gap -- no field counterfactual -- still surfaces normally.
      if (fd && Math.round(fd.pct) === 0) continue;
      out.push(finding(DIM.SETUP, noneScore, `${cn.label}: ${cn.missText} -- ${counter.get(top)}/${field.n} peers ` +
        `${cn.peerVerb} ${wowheadSpell(field.guids.get(top), top)}${cn.note}.${cite} ${cn.tail}`, basis));
    } else if (mineName !== top) {
      // Swap: price the SPECIFIC field-favored item (peers on it vs not), not the
      // have-any delta -- so "defensive flask -> the DPS flask" reads measured.
      const tdRaw = field.topDeltas && field.topDeltas[cn.field];
      // Don't recommend a swap the field MEASURED at ~0% -- telling someone to swap
      // one food/flask/potion for another for no gain is noise, not coaching. (An
      // est swap, with no counterfactual to trust, still surfaces at the estimate.)
      if (tdRaw && Math.round(tdRaw.pct) === 0) continue;
      const td = trust(tdRaw);   // distrust an implausible (> ceiling) confounded delta -> est
      // Combat potions are near-equivalent, so an UNMEASURED potion swap is noise ("I used
      // a different potion because it's what I had -- it's barely a difference"). Require a
      // MEASURED gain (a real with/without delta) to surface a potion swap. Flasks/foods/
      // oils/runes meaningfully differ (a defensive flask IS a real loss), so they keep the
      // est swap even at a slim field majority.
      if (cn.swapNeedsMeasure && !td) continue;
      const swapCite = td ? ` (measured: peers on it do ${Math.round(td.pct)}% more than those without, n=${td.nHave}/${td.nNot})` : "";
      out.push(finding(DIM.SETUP, td ? DPS(Math.round(td.pct)) : cn.swap,
        `${cn.label}: ${wowheadSpell(mineGuid, mineName)} -> ${wowheadSpell(field.guids.get(top), top)}.${swapCite}`,
        td ? "measured" : "est"));
    }
  }
  return out;
}

// Missing enchants (the modern "oil"): slots the field reliably enchants that
// you left bare -- a free parse, same as a flask.
export function enchantLevers(field, my) {
  const missing = [];
  for (const [slotName, counter] of Object.entries(field.enchBySlot)) {
    if (my.ench.has(slotName)) continue;                 // you already enchant this slot
    const top = topEntry(counter);
    if (top && top[1] >= field.n / 2) missing.push([slotName, top[0]]);  // field reliably enchants it
  }
  if (!missing.length) return [];
  const list = missing.map(([s, e]) => `${s} (${e})`).join(", ");
  // Prefer the MEASURED value of each missing slot's enchant (peers who enchant it
  // vs those who leave it bare -- enchDeltas) over the flat count. Same trust/cap as
  // the consumable lever: a confounded delta above CONS_MAX_PCT (better players just
  // enchant AND play better, on a small "bare" group) is distrusted and dropped from
  // the sum. We can claim "measured" only when EVERY missing slot had a usable field
  // counterfactual; otherwise one slot we couldn't price would make the bundled %
  // dishonest, so we fall back to the count estimate. Mirrors the talent lever's
  // all-or-nothing measured rule.
  const ed = field.enchDeltas || {};
  const trusted = missing
    .map(([s]) => ({ slot: s, d: ed[s] }))
    .filter((t) => t.d && Math.round(t.d.pct) <= CONS_MAX_PCT);
  if (trusted.length === missing.length && trusted.length > 0) {
    // Every missing slot had a usable field counterfactual -> price it. Sum the
    // per-slot floors (capped -- enchants are universally small, and the deltas
    // share a confound so the sum is an over-estimate reconcileImpacts trims).
    const sum = trusted.reduce((a, t) => a + t.d.pct, 0);
    const pct = Math.min(Math.max(1, Math.round(sum)), 5);
    // Cite each slot's measured floor (transparent, not one inflated total).
    const cite = ` (measured: ${trusted.map((t) => `${t.slot} +${Math.round(t.d.pct)}%`).join(", ")} -- peers who enchant the slot vs those who leave it bare)`;
    return [finding(DIM.SETUP, DPS(pct), `ENCHANTS: you're missing enchants on ${list}. The field runs them -- a free parse with equal gear.${cite}`, "measured")];
  }
  const est = Math.min(missing.length, 5);
  return [finding(DIM.SETUP, DPS(est), `ENCHANTS: you're missing enchants on ${list}. The field runs them -- a free parse with equal gear.`)];
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
  return [finding(DIM.GEAR, DPS(pct),
    `TRINKETS: the field favors ${parts.join(" and ")} -- you run ${yours}. Trinkets are effect-based, so SIM it (Droptimizer) before committing, but a trinket most peers run and you don't is a common hidden upgrade.`)];
}

// Your secondary % trails the field but there's no lever to close it -- either
// every item is already maxed for the stat (gear/comp-locked), or your gear is
// optimal for what you own. Only fires when gearLevers found no swap/restat
// (those ARE the actionable version of this gap).
export function statGapLever(gf, my, field, priority) {
  const PRI = priority.toUpperCase();
  const statGap = (my.statPct !== null && field && field.statPct) ? field.statPct - my.statPct : 0;
  const hasGearLever = gf && (gf.swaps.length || gf.restats.length);
  if (statGap >= 4 && !hasGearLever) {
    // Measured value of the stat gap: how much more the field's top-half-of-stat
    // peers do. Cite it when we have it; it's context (no swap exists to act on).
    const sd = field && field.statDelta;
    const worth = sd ? ` Measured: peers in the top half of ${priority} do ${Math.round(sd.pct)}% more (n=${sd.nHave}/${sd.nNot}).` : "";
    return [finding(DIM.GEAR, INFO, `${PRI}: yours (${f(my.statPct, 0)}%) is below peers (${f(field.statPct, 0)}%), but NOT actionable -- every item you own is already ${priority}-maxed, no ${priority}-itemized swap exists.${worth} It rises only when ${priority}-itemized drops come.`, sd ? "measured" : "est")];
  }
  if (gf && !gf.swaps.length && !gf.restats.length && statGap < 4) {
    return [finding(DIM.GEAR, INFO, "GEAR/STATS: optimal for what you own -- no lever; gains are future drops + a sim (Droptimizer).")];
  }
  return [];
}