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
