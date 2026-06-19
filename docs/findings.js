// @ts-check
// The FINDING currency every analysis hands to prescribe.js, plus the field-delta
// measurement. Split out of core.js so the foundation reads in cohesive files;
// core.js re-exports these for back-compat.
import { metricUnit } from "./runcontext.js";
import { median } from "./format.js";

// --------------------------------------------------------------------- //
// A finding is { dim, impact, label, text }:
//   dim    -- which analysis it came from ("Execution"|"Rotation"|"Setup"|
//             "Gear"|"Comp"), set explicitly, used to split "yours" from "comp".
//   impact -- numeric DPS %, the ONLY thing the change-list sorts by.
//   label  -- the matching display string ("~3% DPS", "~1-3% DPS", "info").
// DPS()/COMP()/INFO build impact and label together so they can never disagree
// (the old bug: a separate sort key that drifted from the shown %).
// Name kept `DPS` (every call site uses it) but the unit follows the run metric,
// so a healer's levers read "~3% HPS". Default 'dps' keeps "~3% DPS" exactly.
/** @param {number} lo @param {number} [hi] @returns {Score} */
export const DPS = (lo, hi = lo) => ({ impact: (lo + hi) / 2, label: hi > lo ? `~${lo}-${hi}% ${metricUnit()}` : `~${lo}% ${metricUnit()}` });
/** @param {number} pct @returns {Score} */
export const COMP = (pct) => ({ impact: pct, label: `~${pct}% comp` });
/** @type {Score} */
export const INFO = { impact: 0, label: "info" };
// Assemble one finding: finding("Gear", DPS(1, 3), "STAT via ...", "est").
// `basis` is how the impact % was derived, kept honest on every line:
//   "measured" -- computed from YOUR log (idle time, cast/uptime gaps, routing).
//   "est"      -- a category/effect estimate (gear/stat/consumable/comp/rotation
//                 priority); the exact DPS needs a sim. Default "est" -- a lever
//                 must opt IN to claiming it's measured.
/** @param {Dim} dim @param {Score} score @param {string} text @param {"measured"|"est"} [basis] @param {string|null} [kind] @returns {Finding} */
export const finding = (dim, score, text, basis = "est", kind = null) =>
  ({ dim, ...score, text, basis, ...(kind ? { kind } : {}) });

// Which analysis a finding came from (splits "yours to do" from raid comp). The ONE
// definition behind the {Dim} type -- modules reference DIM.GEAR, not the bare string,
// so a typo is a missing-property error, not a silently mis-sorted finding. (Values
// are the exact strings used before, so caches/tests are unchanged.) The last four are
// progression.js's own namespace (raid-night pull analyzer; never fed to prescribe).
export const DIM = Object.freeze({
  EXECUTION: "Execution", ROTATION: "Rotation", SETUP: "Setup", GEAR: "Gear",
  COMP: "Comp", INFO: "Info",
  SURVIVAL: "Survival", DPS_CHECK: "DPSCheck", MECHANIC: "Mechanic", ROSTER: "Roster",
});

// Stable machine tags for the finding kinds prescribe.js special-cases, so it keys off
// `kind` instead of regex-matching the human-facing PROSE (renaming a heading used to
// silently break a code path). An ordinary lever needs no kind (absent = null).
export const KIND = Object.freeze({
  TALENTS: "TALENTS", HERO_TREE: "HERO_TREE", EMPOWERMENT: "EMPOWERMENT",
  COOLDOWN: "COOLDOWN", PRESS_FASTER: "PRESS_FASTER", OVERHEAL: "OVERHEAL", MOVEMENT: "MOVEMENT",
  OPENER: "OPENER", CD_ALIGN: "CD_ALIGN", WEAK_WINDOW: "WEAK_WINDOW", PHASE_DIP: "PHASE_DIP",
});

// Empirically value an attribute from the FIELD's own logs -- the natural
// experiment: median throughput of peers who HAVE it minus peers who don't, as a
// %. `dps` and `has` are parallel arrays over the ilvl-matched peer sample. Needs
// both groups to have >= `min` peers or it's noise -> null (caller keeps an
// estimate). Observational, so confounded (good players do more of everything) --
// a positive delta is a measured FLOOR on the value, not a sim. Clamped to >=0
// (a "have" group that's somehow lower is selection noise, not a negative value).
export function fieldDelta(dps, has, { min = 4 } = {}) {
  const have = [], not = [];
  for (let i = 0; i < dps.length; i++) {
    if (!(dps[i] > 0)) continue;
    (has[i] ? have : not).push(dps[i]);
  }
  if (have.length < min || not.length < min) return null;   // no counterfactual -> not measurable
  const mh = median(have), mn = median(not);
  if (!(mn > 0)) return null;
  return { pct: Math.max(0, (mh - mn) / mn * 100), nHave: have.length, nNot: not.length };
}
