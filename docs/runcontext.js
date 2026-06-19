// @ts-check
// The RUN CONTEXT: spec->role classification + the one module-scoped {metric, support}
// object for a run. Split out of core.js so the foundation reads in cohesive files;
// core.js re-exports these for back-compat.

// The 5 healing spec NAMES cover all 7 healer specs (Holy = Priest+Paladin,
// Restoration = Druid+Shaman). Spec->role is stable game metadata, not a stat
// weight. A healer is measured on HEALING (HPS), everyone else on DAMAGE (DPS).
const HEALER_SPECS = new Set(["Holy", "Discipline", "Restoration", "Mistweaver", "Preservation"]);
/** @param {string} specName @returns {boolean} */
export const isHealer = (specName) => HEALER_SPECS.has(specName);

// SUPPORT specs: their throughput is mostly the buffs/amps they put on ALLIES
// (Ebon Might / Prescience / Breath of Eons), which WCL credits to those allies'
// parses, NOT to the support's personal DPS. So a personal-DPS comparison
// understates their value the same way an HPS comparison mis-measures a healer's.
// Spec->role is stable game metadata (Augmentation is the lone support spec this
// expansion) -- the SAME kind of classification as HEALER_SPECS, not a hard-coded
// ability/stat weight. Officially role=DPS, so this set is how we know otherwise.
const SUPPORT_SPECS = new Set(["Augmentation"]);
/** @param {string} specName @returns {boolean} */
export const isSupport = (specName) => SUPPORT_SPECS.has(specName);

// ATONEMENT-STYLE healers heal THROUGH damage: Discipline Priest's Atonement converts its
// damage into healing; a FISTWEAVING Mistweaver's damage heals via its mastery. For them
// the DAMAGE rotation IS a healing lever (pressing the damage buttons more = more healing),
// unlike a pure healer where "cast more damage" just means less healing. So these specs DO
// get damage-rotation analysis. Discipline ALWAYS qualifies (all its healing is Atonement);
// Mistweaver only when it's actually dealing damage (fistweaving), which the caller confirms
// from the kill's damage share -- a non-fistweaving Mistweaver shouldn't be told to "press
// your damage rotation". Spec->style is stable game metadata, like HEALER_SPECS. The minimum
// fraction of (damage / (damage+healing)) output for a Mistweaver to count as fistweaving.
const ALWAYS_ATONEMENT_SPECS = new Set(["Discipline"]);
const ATONEMENT_IF_DAMAGING_SPECS = new Set(["Mistweaver"]);
export const FISTWEAVE_DAMAGE_SHARE = 0.2;
/** @param {string} specName @returns {boolean} */
export const alwaysAtonement = (specName) => ALWAYS_ATONEMENT_SPECS.has(specName);
/** @param {string} specName @returns {boolean} */
export const atonementIfDamaging = (specName) => ATONEMENT_IF_DAMAGING_SPECS.has(specName);
/** Is this an atonement-style healer GIVEN the kill's damage share? @param {string} specName @param {number} [dmgShare] @returns {boolean} */
export const isAtonement = (specName, dmgShare = 0) =>
  alwaysAtonement(specName) || (atonementIfDamaging(specName) && dmgShare >= FISTWEAVE_DAMAGE_SHARE);

// --------------------------------------------------------------------- //
// Throughput metric: DPS for damage/tank specs, HPS for healers. The whole
// analysis is throughput-generic ("output/sec vs peers", which abilities do the
// most, casts/min) -- only the WCL table (DamageDone vs Healing), the ranking
// metric, and the display label differ.
/** @param {string} className @param {string} specName @returns {"dps"|"hps"} */
export const metricForSpec = (className, specName) => (isHealer(specName) ? "hps" : "dps");

// THE run context: which throughput metric this run measures (DPS vs HPS), and whether
// it's a SUPPORT spec (Augmentation -- frames by buff value, not personal DPS; orthogonal
// to the metric, so it's a separate field). It's ONE module-scoped object on purpose: a
// run analyzes one character in one process, and keeping it here lets the throughput-generic
// constructors -- DPS(), metricUnit(), the WCL table selector -- stay PARAMETER-FREE at
// their hundreds of call sites instead of threading a metric through every function.
// Default 'dps' keeps every damage-spec query BYTE-IDENTICAL to before (same query strings
// -> same caches, same tests). NOTE the asymmetric WCL enum: damage is "DamageDone" but
// healing is just "Healing" (no -Done), in BOTH the TableDataType and EventDataType enums.
const _run = { metric: /** @type {"dps"|"hps"} */ ("dps"), support: false };
// Set the WHOLE context from the spec in ONE atomic call -- the production entry point
// (app/CLI). Derives metric + support together so they can never disagree or be half-set
// (the old two-setter API let a caller set the metric but forget the support flag).
/** @param {string} className @param {string} specName */
export function setRunContext(className, specName) {
  _run.metric = metricForSpec(className, specName);
  _run.support = isSupport(specName);
}
// Reset to the default (dps, non-support). The browser analyzes many characters in one
// page session WITHOUT reload, and detection runs BEFORE setRunContext -- so without a reset
// the previous character's metric leaks into the next one's detection (analyze a healer, then
// a DPS -> detection queries hps rankings the DPS doesn't have -> "couldn't determine class").
// detectContext calls this first so every detection runs metric-neutral (dps works for all
// specs -- the same state as a fresh page load).
export function resetRunContext() { _run.metric = "dps"; _run.support = false; }
// Low-level knobs -- mainly tests, which force a metric without a real spec.
/** @param {"dps"|"hps"} m */
export function setRunMetric(m) { _run.metric = m === "hps" ? "hps" : "dps"; }
/** @param {boolean} b */
export function setRunSupport(b) { _run.support = !!b; }
export function runMetric() { return _run.metric; }
export const runIsHealer = () => _run.metric === "hps";
export const runIsSupport = () => _run.support;
export const metricUnit = () => (_run.metric === "hps" ? "HPS" : "DPS");
export const throughputWord = () => (_run.metric === "hps" ? "healing" : "damage");
const throughputTable = () => (_run.metric === "hps" ? "Healing" : "DamageDone");
export const eventTable = throughputTable;
