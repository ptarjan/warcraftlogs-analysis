// @ts-check
// Shared constants, formatting helpers, and low-level WCL fetchers.
// Ported from analyze.py's fetcher layer; imported by the analysis modules.
import { gql } from "./wcl.js";

export const DIFFICULTY = { 2: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic" };

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
// metric, and the display label differ. We pick ONE metric per run from the
// player's spec and stash it module-level (a run analyzes one character, in one
// process, start to finish). Default 'dps' keeps every damage-spec query
// BYTE-IDENTICAL to before (same query strings -> same caches, same tests).
/** @param {string} className @param {string} specName @returns {"dps"|"hps"} */
export const metricForSpec = (className, specName) => (isHealer(specName) ? "hps" : "dps");
let _metric = "dps";
/** @param {"dps"|"hps"} m */
export function setRunMetric(m) { _metric = m === "hps" ? "hps" : "dps"; }
export function runMetric() { return _metric; }
export const runIsHealer = () => _metric === "hps";

// A support run still uses the DPS metric/tables (Augmentation IS a damage actor),
// but the FRAMING differs: personal DPS isn't the right yardstick. Tracked as a
// separate flag (orthogonal to the dps/hps metric), set from the spec at run start.
let _support = false;
/** @param {boolean} b */
export function setRunSupport(b) { _support = !!b; }
export const runIsSupport = () => _support;
// Display + table helpers so output reads "HPS"/"healing" for healers, and the
// WCL table + per-hit event type follow the same switch. NOTE the asymmetric WCL
// enum: damage is "DamageDone" but healing is just "Healing" (no -Done), in BOTH
// the TableDataType and EventDataType enums.
export const metricUnit = () => (_metric === "hps" ? "HPS" : "DPS");
export const throughputWord = () => (_metric === "hps" ? "healing" : "damage");
const throughputTable = () => (_metric === "hps" ? "Healing" : "DamageDone");
export const eventTable = throughputTable;

// Slots the field actually enchants (verify each season). Display only.
export const ENCHANTABLE_SLOTS = {
  0: "Head", 4: "Chest", 6: "Legs", 7: "Feet", 8: "Wrist",
  10: "Ring1", 11: "Ring2", 14: "Back", 15: "Weapon",
};

// ---- formatting helpers (approximate the Python f-string columns) ---- //
export function f(x, d = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "nan";
  return Number(x).toLocaleString("en-US", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
}
export const padL = (s, n) => String(s).padStart(n);
export const padR = (s, n) => String(s).padEnd(n);
export const slug = (s) => s.toLowerCase().replaceAll(" ", "-");
const clean = (s) => String(s).replaceAll('"', "");
// Character lookups are case-insensitive on WCL, so normalize to WoW's canonical
// casing (first letter upper, rest lower -- a no-op for caseless scripts) and the
// region to upper. This makes the query string -- and therefore every cache key
// (gql memo + IndexedDB) -- identical regardless of the input's case, so "Hadryan"
// and "hadryan" share one fetch instead of paying twice.
const cName = (s) => { const c = clean(s).trim(); return c ? c[0].toUpperCase() + c.slice(1).toLowerCase() : c; };
const cRegion = (s) => clean(s).trim().toUpperCase();

// Top-n [key, count] entries of a Map counter, highest count first. The single
// definition for the "most popular item/gem/trinket the field runs" pattern that was
// re-inlined (`[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n)`) across modules.
export const topN = (counter, n = Infinity) =>
  counter ? [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n) : [];
// Highest-count [key, count] entry of a Map counter, or null when empty.
export const topEntry = (counter) => topN(counter, 1)[0] || null;

export function median(arr) {
  const a = arr.filter((x) => x !== null && x !== undefined && !Number.isNaN(x))
    .slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Round a ratio to an integer percent: pct(n, d) === Math.round(100*n/d). The single
// definition for the ~30 inline `Math.round(100*x/y)` sites. Optional cap/floor clamp
// the result; {round:false} keeps the float. d <= 0 -> 0 (no divide-by-zero / NaN).
export function pct(n, d, { cap = Infinity, floor = -Infinity, round = true } = {}) {
  if (!(d > 0)) return 0;
  const v = Math.min(cap, Math.max(floor, (100 * n) / d));
  return round ? Math.round(v) : v;
}

// --------------------------------------------------------------------- //
// Finding: the shared currency every analysis hands to prescribe.js
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
  COOLDOWN: "COOLDOWN", PRESS_FASTER: "PRESS_FASTER",
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

// --------------------------------------------------------------------- //
// Low-level fetchers
// --------------------------------------------------------------------- //
export async function characterZone(name, server, region, difficulty) {
  const q = `query { characterData { character(
    name:"${cName(name)}", serverSlug:"${slug(clean(server))}", serverRegion:"${cRegion(region)}") {
    id classID zoneRankings(difficulty:${difficulty}) } } }`;
  const c = (await gql(q)).characterData.character;
  if (!c) throw new Error(`Character not found: ${name}-${server}-${region}`);
  return c;
}

// Factored so the single-encounter query and the bundled multi-encounter query share
// EXACT text (the cache key) -- verified to reproduce existing cached keys byte-for-byte.
const _charHead = (name, server, region) =>
  `character(\n    name:"${cName(name)}", serverSlug:"${slug(clean(server))}", serverRegion:"${cRegion(region)}")`;
const _encField = (encounterId, difficulty) =>
  `encounterRankings(encounterID:${encounterId}, difficulty:${difficulty}, metric:${_metric})`;
export const _characterEncounterQuery = (name, server, region, encounterId, difficulty) =>
  `query { characterData { ${_charHead(name, server, region)} {\n    ${_encField(encounterId, difficulty)} } } }`;
export async function characterEncounter(name, server, region, encounterId, difficulty) {
  const c = (await gql(_characterEncounterQuery(name, server, region, encounterId, difficulty))).characterData.character;
  return c ? c.encounterRankings : null;
}


export async function topRankings(encounterId, difficulty, className, specName, page = 1) {
  const q = `query { worldData { encounter(id:${encounterId}) { characterRankings(
    difficulty:${difficulty}, className:"${clean(className)}", specName:"${clean(specName)}", metric:${_metric}, page:${page}) } } }`;
  const cr = (await gql(q)).worldData.encounter.characterRankings;
  return cr && typeof cr === "object" ? (cr.rankings || []) : [];
}

// Bounded-concurrency map: run fn over items with at most `limit` in flight.
// Faster than sequential awaits, but capped so we don't burst the shared WCL
// rate limit. Results are returned in input order; fn errors become null.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Like mapLimit but STOPS once `n` successful (non-null) results are collected,
// processing `items` in order in waves of `limit`. The peer lists carry a small
// buffer of extra candidates against failures (private logs etc.); fetching ALL of
// them then slicing to `n` wastes requests (= WCL points) in the common case where
// the first `n` succeed. This fetches the buffer ONLY to backfill a failure. Returns
// the first `n` successful results in item order -- identical to
// `(await mapLimit(items, limit, fn)).filter(Boolean).slice(0, n)`, just lazier.
export async function collectUpTo(items, n, limit, fn) {
  const ok = [];
  for (let i = 0; i < items.length && ok.length < n; i += limit) {
    const wave = await mapLimit(items.slice(i, i + limit), limit, (it, j) => fn(it, i + j));
    for (const r of wave) if (r != null && ok.length < n) ok.push(r);
  }
  return ok;
}

function entry(tableData, name, specName) {
  const entries = tableData.entries || [];
  const lc = String(name || "").toLowerCase();
  let hit = entries.filter((e) => String(e.name || "").toLowerCase() === lc);
  if (!hit.length) hit = entries.filter((e) => specName && String(e.icon || "").includes(specName));
  return hit.length ? hit[0] : null;
}

// Build a metrics object from already-fetched DamageDone + Casts table data.
function metricsFromTables(dmg, casts, name, specName) {
  const dur = dmg.totalTime / 1000.0;
  const e = entry(dmg, name, specName);
  if (!e) return null;
  const ce = entry(casts, e.name, specName);
  const castCounts = {};
  for (const a of (ce ? ce.abilities : [])) castCounts[a.name] = a.total;
  const dmgBy = {};
  for (const a of e.abilities) dmgBy[a.name] = a.total;
  // Overhealing: the Healing table carries `overheal` per actor AND per ability
  // (effective `total` excludes it); the DamageDone table has no such field, so it
  // reads `undefined -> 0` and every DPS consumer is unaffected (byte-identical).
  // overhealPct = spilled / (effective + spilled) -- the wasted fraction of output,
  // the flagship healer efficiency signal. No new query: rides reportCore's table.
  const overheal = e.overheal || 0;
  const overhealBy = {};
  for (const a of e.abilities) overhealBy[a.name] = a.overheal || 0;
  const totalCasts = Object.values(castCounts).reduce((s, v) => s + v, 0);
  return {
    name: e.name, ilvl: e.itemLevel, dur,
    dps: e.total / dur, total: e.total,
    activePct: dmg.totalTime ? 100 * (e.activeTime || 0) / dmg.totalTime : 0,
    targets: (e.targets || []).length,
    // per-target damage totals (for damage-routing / cleave-funnel analysis)
    dmgTargets: e.targets || [],
    casts: castCounts, dmgBy: dmgBy,
    overheal, overhealBy,
    overhealPct: (e.total + overheal) > 0 ? 100 * overheal / (e.total + overheal) : 0,
    castsPerMin: dur ? totalCasts / (dur / 60) : 0,
    sourceID: e.id, gear: e.gear || [],
  };
}

// Central per-(report, fight) loader: ONE query for the damage + cast tables, the
// CombatantInfo events (secondary stats), and the fight window. The tables are
// fetched UNFILTERED (no sourceClass) -- consumers pick their player by name in
// metricsFromTables -- so a kill's DamageDone/Casts is fetched exactly ONCE no
// matter who asks or what class filter they'd otherwise use. WCL bills by query
// COMPLEXITY (measured: ~4.25 pts per report read + ~1.2 pts/request overhead), so the
// structural point saving is fetching each table ONCE -- fewer report-UNITS, the thing
// that actually costs points -- not the request count. The report-block fields
// reportCore reads. Factored out + frozen (loader test) so the query string is a
// stable cache key the gql() auto-batcher can combine and split.
const _reportCoreBody = (fight) => `
    dmg: table(fightIDs:${fight}, dataType:${throughputTable()})
    casts: table(fightIDs:${fight}, dataType:Casts)
    combatant: events(fightIDs:${fight}, dataType:CombatantInfo, limit:50) { data }
    fightWin: fights(fightIDs:${fight}) { startTime endTime }`;
export const _reportCoreQuery = (code, fight) =>
  `query { reportData { report(code:"${code}") {${_reportCoreBody(fight)} } } }`;

// Memoized by query string via the gql cache; the loader test enforces "each
// table once per report". No className: the data is identical for every caller.
export async function reportCore(code, fight) {
  return (await gql(_reportCoreQuery(code, fight))).reportData.report;
}

// Request bundling is now AUTOMATIC in the fetch layer: concurrent cache-misses are
// combined into one GraphQL request by gql() itself (wcl.js), so the per-peer loops
// (which already run concurrently via mapLimit/collectUpTo) batch with no wiring here.
// The old hand-written prefetch* bundlers were replaced by that.

// Damage + cast metrics for one player on one fight (className arg ignored -- the
// loader is unfiltered; kept for call-site compatibility).
export async function playerMetrics(code, fight, name, specName, className) {
  const d = await reportCore(code, fight);
  return metricsFromTables(d.dmg.data, d.casts.data, name, specName);
}

// A player's FULL damage-ability breakdown, from a sourceID-FILTERED DamageDone
// table. reportCore's UNFILTERED table truncates to ~5 abilities PER ACTOR -- and
// for a caster those top-5-by-total often DROP the core casts (a Frost Mage's
// Frostbolt / Ice Lance / Glacial Spike were missing), so any cast rate built from
// it undercounts APM ~5x (a mage read "9 casts/min" when it's really ~50) and the
// rotation comparison can't see the real buttons. The filtered table returns them
// all. Memoized by the gql cache (one fetch per report+fight+source; the loader
// test keys units by sourceID). Entries: { name, guid, total, uses, ... }, by total.
export async function playerAbilities(code, fight, sourceId) {
  const q = `query { reportData { report(code:"${code}") {
    table(fightIDs:${fight}, dataType:${throughputTable()}, sourceID:${sourceId}) } } }`;
  const t = (await gql(q)).reportData.report.table.data;
  return (t.entries || []).filter((a) => a.guid != null && a.total > 0)
    .sort((a, b) => b.total - a.total);
}

// Per-ability OVERHEAL for a healer, keyed by ability name. The UNFILTERED reportCore
// Healing table gives entry-level overheal but its per-ability objects DON'T carry it;
// the sourceID-FILTERED Healing table's entries ARE the abilities, each with `total`
// (effective) AND `overheal`. Reuses playerAbilities' fetch (metric-aware -> Healing
// for a healer), so it dedupes with the rotation analysis. Healer-only (the DamageDone
// table has no overheal -> all zeros). Returns { overhealBy, effBy } by ability name.
export async function healingBreakdown(code, fight, sourceId) {
  const abs = await playerAbilities(code, fight, sourceId);
  const overhealBy = {}, effBy = {};
  for (const a of abs) { overhealBy[a.name] = a.overheal || 0; effBy[a.name] = a.total || 0; }
  return { overhealBy, effBy };
}

// Healer MANA over the fight, from cast events carrying a resource snapshot
// (`includeResources` rides current mana on every Casts event; mana = class resource
// type 0). Returns { endPct, minPct, oom } -- end-of-fight mana %, the low-water mark,
// and ms into the fight you first hit ~empty (<=5%), or null. A separate query from the
// shared loader (includeResources would bloat every spec's Casts fetch), so it's
// healer-only; one page covers a healer's casts. null when there's no mana data.
export async function manaStats(code, fight, sourceId) {
  const [s, e] = await fightWindow(code, fight);
  const q = `query { reportData { report(code:"${code}") { events(
    fightIDs:${fight}, sourceID:${sourceId}, dataType:Casts, includeResources:true,
    limit:10000, startTime:${s}, endTime:${e}) { data } } } }`;
  const rows = (await gql(q)).reportData.report.events.data;
  const series = rows.map((x) => {
    const m = (x.classResources || []).find((r) => r.type === 0);   // type 0 = mana
    return m && m.max ? { t: x.timestamp - s, pct: 100 * m.amount / m.max } : null;
  }).filter(Boolean);
  if (series.length < 3) return null;
  const last = series[series.length - 1];
  const oom = series.find((r) => r.pct <= 5);
  return { endPct: last.pct, minPct: Math.min(...series.map((r) => r.pct)), oom: oom ? oom.t : null };
}

// A player's DoT/debuff UPTIME% on the PRIMARY (boss) target, per ability id.
// DoT specs keep most of their damage in DoT uptime, which cast/cooldown levers
// can't see -- this exposes it. ONE batched query (aliased Debuffs tables per id).
// Gotcha: the Debuffs table with sourceID ALONE returns debuffs ON the player
// (Sated/trinkets) -- you MUST add abilityID to get the player's APPLIED debuff,
// which comes back as one aura PER TARGET; the boss is the max-uptime one. Memoized
// by the gql cache (each (report,fight,Debuffs,src,ability) is a distinct unit).
export async function dotUptimes(code, fight, sourceId, ids, durMs) {
  if (!ids || !ids.length || !durMs) return {};
  const aliases = ids.map((id, i) =>
    `u${i}:table(fightIDs:${fight}, dataType:Debuffs, abilityID:${id}, sourceID:${sourceId})`).join(" ");
  const r = (await gql(`query { reportData { report(code:"${code}") { ${aliases} } } }`)).reportData.report;
  const out = {};
  ids.forEach((id, i) => {
    const auras = (r[`u${i}`] && r[`u${i}`].data.auras) || [];
    const mx = auras.reduce((x, a) => Math.max(x, a.totalUptime || 0), 0); // primary (boss) target
    out[id] = Math.round((100 * mx) / durMs);
  });
  return out;
}

// Fight window [start, end] in ms -- from the shared loader query.
export async function fightWindow(code, fight) {
  const d = await reportCore(code, fight);
  const w = (d.fightWin || [])[0] || {};
  return [w.startTime || 0, w.endTime || 0];
}

// Generic paginated events for one actor (overflow beyond the 10k page limit).
export async function paginateEvents(code, fight, sourceId, dataType, abilityId = null, start = null, end = null) {
  const out = [];
  const ab = abilityId !== null ? `, abilityID: ${abilityId}` : "";
  let cursor = start;
  for (;;) {
    const stArg = cursor !== null && cursor !== undefined ? `, startTime: ${cursor}` : "";
    const enArg = end !== null && end !== undefined ? `, endTime: ${end}` : "";
    const q = `query { reportData { report(code:"${code}") { events(
      fightIDs:${fight}, sourceID:${sourceId}, dataType:${dataType}, limit:10000${ab}${stArg}${enArg}) {
      data nextPageTimestamp } } } }`;
    const ev = (await gql(q)).reportData.report.events;
    out.push(...ev.data);
    if (!ev.nextPageTimestamp) break;
    cursor = ev.nextPageTimestamp;
  }
  return out;
}

// Casts + auto-attack events for one actor on one fight, in ONE query -- shared by
// the timeline diagnosis AND the rotation opener so a kill's Casts/autos are
// fetched once. Each is well under the 10k page limit for a single player (a
// second page is rare and handled). Melee autos = ability 1; if empty
// (hunters/casters) fall back to Auto Shot (75).
const _fightEventsBody = (fight, sourceId, start, end) => {
  const win = `, startTime: ${start}, endTime: ${end}`;
  return `
    casts: events(fightIDs:${fight}, sourceID:${sourceId}, dataType:Casts, limit:10000${win}) { data nextPageTimestamp }
    autos: events(fightIDs:${fight}, sourceID:${sourceId}, dataType:DamageDone, abilityID:1, limit:10000${win}) { data nextPageTimestamp }`;
};
export const _fightEventsQuery = (code, fight, sourceId, start, end) =>
  `query { reportData { report(code:"${code}") {${_fightEventsBody(fight, sourceId, start, end)} } } }`;
// `autoFallback`: when ability-1 (melee) autos are empty, retry Auto Shot (75) for
// HUNTERS. Casters have NEITHER, so that retry just fetches an empty set -- one wasted
// request PER PEER (~80 for a caster analysis). Callers that already know the spec has
// no autos (the timeline learns it from YOUR kills) pass autoFallback:false to skip it.
// The MAIN query is unchanged either way, so cached fightEvents stay valid (no orphaning).
export async function fightEvents(code, fight, sourceId, start, end, { autoFallback = true } = {}) {
  const r = (await gql(_fightEventsQuery(code, fight, sourceId, start, end))).reportData.report;
  let casts = r.casts.data, autos = r.autos.data;
  if (r.casts.nextPageTimestamp) casts = casts.concat(await paginateEvents(code, fight, sourceId, "Casts", null, r.casts.nextPageTimestamp, end));
  if (r.autos.nextPageTimestamp) autos = autos.concat(await paginateEvents(code, fight, sourceId, "DamageDone", 1, r.autos.nextPageTimestamp, end));
  if (autoFallback && !autos.length) autos = await paginateEvents(code, fight, sourceId, "DamageDone", 75, start, end);
  return { casts: casts.filter((e) => !e.fake), autos };
}

// --------------------------------------------------------------------- //
// Pull/progression fetchers (the raid-night flow -- see progression.js)
// --------------------------------------------------------------------- //
// ONE bare fights() query for the WHOLE report: every pull's metadata in a single
// request -- the cheap backbone for trend/wall/kill detection and who's present.
// `fresh` bypasses the cache for LIVE polling (an in-progress report's fight list
// grows); finished reports use the default permanent cache. Single canonical query
// string so it memoizes. Per-pull TABLES still go through reportCore (immutable).
export async function reportFights(code, { fresh = false } = {}) {
  const q = `query { reportData { report(code:"${clean(code)}") { fights {
    id startTime endTime name kill fightPercentage bossPercentage difficulty size
    encounterID lastPhase averageItemLevel friendlyPlayers } } } }`;
  return ((await gql(q, 6, { fresh })).reportData.report.fights) || [];
}

// All death events across a SET of pulls in ONE request (deaths are low-volume, so
// a whole night fits well under the 10k page limit; paginate just in case). No
// sourceID -- we want every raider's death. Each event carries `fight` so we bucket
// by pull client-side. `killingAbilityGameID` is the killing blow; `targetID` the
// victim (resolve to a name via reportRoster).
// Distinct boss encounters in a report's fights, for the progression UI's picker.
// Dedupe by encounterID (keep first seen), drop trash pulls (encounterID 0/absent).
export function encountersIn(fights) {
  const seen = new Map();
  for (const fight of (fights || [])) {
    if (!fight || !fight.encounterID || seen.has(fight.encounterID)) continue;
    seen.set(fight.encounterID, { encounterID: fight.encounterID, name: fight.name, difficulty: fight.difficulty });
  }
  return [...seen.values()];
}

export async function reportDeaths(code, fightIDs, { fresh = false } = {}) {
  const ids = `[${(fightIDs || []).join(",")}]`;
  const out = [];
  let cursor = null;
  for (;;) {
    const stArg = cursor != null ? `, startTime: ${cursor}` : "";
    const q = `query { reportData { report(code:"${clean(code)}") { events(
      fightIDs:${ids}, dataType:Deaths, limit:10000${stArg}) { data nextPageTimestamp } } } }`;
    const ev = (await gql(q, 6, { fresh })).reportData.report.events;
    out.push(...(ev.data || []));
    if (!ev.nextPageTimestamp) break;
    cursor = ev.nextPageTimestamp;
  }
  return out;
}

// Report-local actor id -> { name, type, subType } map, so death/roster ids resolve
// to player names + class (subType is the class for a Player actor). One light
// query per report.
export async function reportRoster(code) {
  const q = `query { reportData { report(code:"${clean(code)}") {
    masterData { actors { id name type subType petOwner } } } } }`;
  const actors = (((await gql(q)).reportData.report.masterData) || {}).actors || [];
  const byId = new Map();
  for (const a of actors) byId.set(a.id, a);
  return byId;
}

// Total PET damage for one owner on one fight. Pet-heavy specs (Unholy DK, BM
// Hunter, Demo Lock) keep a big chunk of their damage in pets (summons, transforms,
// Army/Gargoyle) -- which the cast/cooldown levers can't see, so it sits in the
// PLAYSTYLE remainder. WCL folds pet damage into the owner's ranking DPS, so this
// ATTRIBUTES part of the gap (your pet share vs the field's), it doesn't add new DPS.
// One batched query over the owner's pet actor ids (from reportRoster's petOwner).
export async function petDamage(code, fight, ownerSourceId) {
  const roster = await reportRoster(code);
  const petIds = [...roster.values()].filter((a) => a.petOwner === ownerSourceId).map((a) => a.id);
  if (!petIds.length) return 0;
  const aliases = petIds.map((id, i) =>
    `p${i}:table(fightIDs:${fight}, dataType:${throughputTable()}, sourceID:${id})`).join(" ");
  const r = (await gql(`query { reportData { report(code:"${code}") { ${aliases} } } }`)).reportData.report;
  let total = 0;
  petIds.forEach((id, i) => {
    total += (((r[`p${i}`] && r[`p${i}`].data.entries) || []).reduce((s, e) => s + (e.total || 0), 0));
  });
  return total;
}

// Median field KILL time (ms) for an encounter -- the reference for sizing a DPS
// check (how long the field takes to kill, vs how long the group survives at the
// wall). Top parses are all kills, so their `duration` is the kill time; metric is
// the run metric (kill time is the same regardless, but the query needs one).
export async function encounterKillTimes(encounterId, difficulty) {
  const q = `query { worldData { encounter(id:${encounterId}) { characterRankings(
    difficulty:${difficulty}, metric:${_metric}, page:1) } } }`;
  const cr = (await gql(q)).worldData.encounter.characterRankings;
  const ranks = (cr && typeof cr === "object" ? (cr.rankings || []) : []);
  return ranks.map((r) => r.duration).filter((d) => d > 0);
}

// Report codes where this character pulled a given boss, NEWEST first -- for the
// "whole progression" (multi-night) view. Kill-rankings only list nights the boss
// DIED, so we also walk recentReports to catch wipe-only progression nights (the
// caller filters those to reports that actually contain the encounter).
export async function reportsForBoss(name, server, region, encounterId, difficulty, { maxReports = 20 } = {}) {
  const seen = new Set(), out = [];
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  for (const rk of ((er && er.ranks) || [])) {
    const code = rk.report && rk.report.code;
    if (code && !seen.has(code)) { seen.add(code); out.push({ code, startTime: rk.startTime || 0, killed: true }); }
  }
  try {
    const q = `query { characterData { character(
      name:"${cName(name)}", serverSlug:"${slug(clean(server))}", serverRegion:"${cRegion(region)}") {
      recentReports(limit:${maxReports}) { data { code startTime } } } } }`;
    const rr = ((((await gql(q)).characterData.character || {}).recentReports) || {}).data || [];
    for (const r of rr) if (r.code && !seen.has(r.code)) { seen.add(r.code); out.push({ code: r.code, startTime: r.startTime || 0, killed: false }); }
  } catch { /* best effort -- kill reports alone still work */ }
  return out.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

// A character's recent reports (raid nights), newest first -- for the progression
// flow's "pick a recent raid" quick-picks. Best-effort; [] on any hiccup.
export async function recentReportsFor(name, server, region, limit = 12) {
  try {
    const q = `query { characterData { character(
      name:"${cName(name)}", serverSlug:"${slug(clean(server))}", serverRegion:"${cRegion(region)}") {
      recentReports(limit:${limit}) { data { code startTime title zone { name } } } } } }`;
    const c = (await gql(q)).characterData.character;
    const data = (((c && c.recentReports) || {}).data) || [];
    return data.filter((r) => r && r.code).sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  } catch { return []; }
}

// Parse a WCL report reference -- a full URL, a "?code=..&fight=.." link, or a bare
// report code -- into { code, fight }. `fight` is the optional fight id ("last" or a
// number) from the URL fragment; null if absent.
export function parseReportRef(input) {
  const s = String(input || "").trim();
  const m = s.match(/reports\/(?:a:)?([A-Za-z0-9]{10,})/) || s.match(/[?&]code=([A-Za-z0-9]{10,})/) || s.match(/^([A-Za-z0-9]{10,})$/);
  const code = m ? m[1] : "";
  const fm = s.match(/[#&?]fight=(\d+|last)/);
  return { code, fight: fm ? fm[1] : null };
}

// Self-buff uptime % keyed by buff name (match by keyword to compare).
const _buffUptimesBody = (fight, sourceId) => `
    table(fightIDs:${fight}, dataType:Buffs, sourceID:${sourceId})`;
export const _buffUptimesQuery = (code, fight, sourceId) =>
  `query { reportData { report(code:"${code}") {${_buffUptimesBody(fight, sourceId)} } } }`;
export async function buffUptimes(code, fight, sourceId) {
  const d = (await gql(_buffUptimesQuery(code, fight, sourceId))).reportData.report.table.data;
  const tt = d.totalTime;
  const out = {};
  // name -> { pct, guid }: keep the aura's spell id so flask/food findings can
  // link to Wowhead (the consumable's buff is a spell).
  for (const a of d.auras) if (tt) out[a.name] = { pct: 100 * (a.totalUptime || 0) / tt, guid: a.guid };
  return out;
}

// Debuff uptime % on the ENEMIES, keyed by debuff name -- for raid-comp amps
// that live on the boss, not on you (Chaos Brand, Mystic Touch). Same shape as
// buffUptimes. Uptime is relative to the table's total enemy time, so it's a
// presence signal (a maintained debuff reads high), not an exact per-target %.
export async function bossDebuffs(code, fight) {
  const q = `query { reportData { report(code:"${code}") {
    table(fightIDs:${fight}, dataType:Debuffs, hostilityType:Enemies) } } }`;
  const d = (await gql(q)).reportData.report.table.data;
  const tt = d.totalTime;
  const out = {};
  for (const a of (d.auras || [])) if (tt) out[a.name] = { pct: 100 * (a.totalUptime || 0) / tt, guid: a.guid };
  return out;
}

// Crit/haste/mastery/vers ratings from the shared loader's CombatantInfo data, so
// it rides on the playerMetrics query for the same kill (className arg ignored).
export async function secondaryStats(code, fight, sourceId, className) {
  const d = await reportCore(code, fight);
  for (const e of ((d.combatant && d.combatant.data) || [])) {
    if (e.sourceID === sourceId) {
      return {
        agi: e.agility || 0, stam: e.stamina || 0,
        crit: e.critMelee || 0, haste: e.hasteMelee || 0,
        mastery: e.mastery || 0, vers: e.versatilityDamageDone || 0,
      };
    }
  }
  return null;
}

// --------------------------------------------------------------------- //
// "Best kill" helpers (shared by every analysis)
// --------------------------------------------------------------------- //
// Ranked parses are logged at the item level AT THE TIME. "Current gear" is your
// top item level, but among kills at that level we want the MOST RECENT one --
// otherwise an old high-ilvl kill (a lucky early drop) hides enchant/gem/
// consumable fixes you've made since. So: keep within 1 ilvl of your best, then
// take the latest by startTime. bestRank does this for one encounter's ranks;
// bestKill does it across every boss you've killed.
const RECENT_ILVL_BAND = 1; // kills within this many ilvls count as "current gear"
// Most-recent kill within RECENT_ILVL_BAND of the player's top ilvl. `specName`
// (optional) restricts to kills the player played on THAT spec -- a spec-flexer's
// off-spec kills must NOT seed a benchmark/measurement for the detected spec (the
// bug: an Unholy DK's median-parse kill was a FROST one, so prescribe measured 0%
// pet damage / 0 Scourge Strike against UNHOLY peers). Each WCL rank carries `spec`;
// we filter only when that data is present, so spec-less callers/mocks are unchanged.
export const bestRank = (ranks, specName) => {
  let rs = ranks || [];
  if (specName != null && rs.some((r) => r.spec != null)) rs = rs.filter((r) => r.spec === specName);
  if (!rs.length) return null;
  const maxIl = Math.max(...rs.map((r) => r.bracketData || 0));
  return rs.filter((r) => (r.bracketData || 0) >= maxIl - RECENT_ILVL_BAND)
    .reduce((a, b) => ((b.startTime || 0) > (a.startTime || 0) ? b : a));
};

export async function bestKill(name, server, region, difficulty) {
  const c = await characterZone(name, server, region, difficulty);
  const ranks = (c.zoneRankings.rankings || []).filter((r) => (r.totalKills || 0) > 0);
  const ers = await mapLimit(ranks, 5, (r) =>
    characterEncounter(name, server, region, r.encounter.id, difficulty));
  // Every individual kill, tagged with its boss, so we can pick the most recent
  // at ~your top item level rather than the single highest-ilvl one.
  const all = [];
  ranks.forEach((r, i) => {
    for (const k of ((ers[i] && ers[i].ranks) || [])) {
      all.push({ code: k.report.code, fight: k.report.fightID, ilvl: k.bracketData || 0,
        startTime: k.startTime || 0, encounter: r.encounter, rankPercent: k.rankPercent });
    }
  });
  let best = null;
  if (all.length) {
    const maxIl = Math.max(...all.map((k) => k.ilvl));
    best = all.filter((k) => k.ilvl >= maxIl - RECENT_ILVL_BAND)
      .reduce((a, b) => (b.startTime > a.startTime ? b : a));
  }
  if (best) best.killedIds = ranks.map((r) => r.encounter.id);
  return best;
}

// Killed bosses, NEWEST kill first. So a section that caps how many bosses it
// deep-analyzes keeps your most RECENT fights (current gear/play) instead of
// whatever order zoneRankings returns. Each entry carries the best-ilvl ("current
// gear") kill to compare on, plus the boss's newest kill time for the ordering.
// The per-boss characterEncounter calls are the SAME ones bestKill / prescribe /
// timeline already make, so the gql cache makes this near-free -- it piggybacks
// on their requests rather than adding its own.
export async function recentKills(name, server, region, difficulty) {
  const c = await characterZone(name, server, region, difficulty);
  const ranks = (c.zoneRankings.rankings || []).filter((r) => (r.totalKills || 0) > 0);
  const ers = await mapLimit(ranks, 5, (r) =>
    characterEncounter(name, server, region, r.encounter.id, difficulty));
  const out = [];
  ranks.forEach((r, i) => {
    const kr = (ers[i] && ers[i].ranks) || [];
    const best = bestRank(kr);
    if (!best) return;
    const recent = kr.reduce((mx, k) => Math.max(mx, k.startTime || 0), 0);
    out.push({ encounter: r.encounter, rankPercent: r.rankPercent, recent,
      code: best.report.code, fight: best.report.fightID, ilvl: best.bracketData || 0 });
  });
  return out.sort((a, b) => b.recent - a.recent);
}

// --------------------------------------------------------------------- //
// Field sampling (one collector for every "compare vs peers" analysis)
// --------------------------------------------------------------------- //
// Scan the top DPS rankings for a spec and return up to `limit` ranking entries
// to fetch. Options cover every caller's needs:
//   encounters: one or more encounter ids to draw from (deduped by name+server)
//   pages:      how many ranking pages to scan per encounter
//   ilvl/window: when ilvl is set, keep only parses within +/-window of it
// Callers then mapLimit() over the result to pull whatever per-peer data they
// need (metrics, buffs, stats, timeline, ...).
export async function collectPeers({
  encounters, difficulty, className, specName,
  limit = 10, pages = 4, ilvl = null, window = 3, dedupe = true,
}) {
  const ids = Array.isArray(encounters) ? encounters : [encounters];
  const seen = new Set();
  const cands = [];
  for (const eid of ids) {
    if (cands.length >= limit) break;
    for (let page = 1; page <= pages; page++) {
      if (cands.length >= limit) break;
      for (const r of await topRankings(eid, difficulty, className, specName, page)) {
        if (dedupe) {
          const k = `${r.name}|${(r.server || {}).name}`;
          if (seen.has(k)) continue;
          seen.add(k);
        }
        if (ilvl != null && !(r.bracketData && Math.abs(r.bracketData - ilvl) <= window)) continue;
        cands.push(r);
        if (cands.length >= limit) break;
      }
    }
  }
  return cands;
}

// THE one definition of "the field at YOUR item level on this boss". Both the
// overview and the timeline comparisons compare you to ilvl-matched peers -- if
// they pick DIFFERENT peer sets, their per-peer reportCore fetches don't dedupe
// (a pile of redundant requests). So the selection lives in EXACTLY ONE place:
// the collectPeers params AND the target ilvl (your top ilvl on this boss). Both
// callers go through this, so they can't drift apart. They differ only in which
// metric they map over the SAME candidates (playerMetrics vs fightMetrics+events),
// and those fetches coalesce. Returns the candidate ranking entries; PEER_SAMPLE
// is how many each caller keeps after dropping the ones that fail to load.
// Because the SAME set now serves overview/timeline/rotation/prescribe (one fetch
// shared, not four divergent ones), we can afford a bigger sample than any single
// section used before -- better medians for fewer total requests.
export const PEER_SAMPLE = 10;
// How many BOSSES to analyze concurrently in the cross-boss sections (overview,
// timeline, prescribe's execution aggregate). Each boss is an independent peer
// discovery + fetch wave, so fanning them out collapses ~8 sequential boss-analyses
// into ~2 waves -- the dominant wall-clock win. Bounded (not unbounded Promise.all)
// so the gql() batcher packs each wave instead of bursting WCL's per-second throttle.
export const BOSS_FANOUT = 6;
export async function ilvlPeers(name, server, region, encounter, difficulty, className, specName, { window = 3 } = {}) {
  const er = await characterEncounter(name, server, region, encounter.id, difficulty);
  const ranks = (er && er.ranks) || [];
  if (!ranks.length) return [];
  const ilvl = Math.max(...ranks.map((r) => r.bracketData || 0)) || 0;
  const cands = await collectPeers({ encounters: encounter.id, difficulty, className, specName,
    limit: PEER_SAMPLE + 3, pages: 7, ilvl, window });
  // Pre-warm the peers we'll actually use (the buffer is left for lazy backfill) in
  // ONE bundled request instead of one each -- the big per-request budget win. Best
  // effort; on any issue the consumers fetch each peer individually as before.
  return cands;
}

// THE top-DPS field for a spec (the META -- NOT ilvl-matched; that's ilvlPeers).
// The single selector gear and talents share, so they pick the same players and
// their fetches dedupe. Candidate order is deterministic (top rankings), so a
// caller taking fewer players gets a prefix of a caller taking more -- the
// overlap still coalesces.
export async function topField(className, specName, difficulty, encounters, limit) {
  return collectPeers({ encounters, difficulty, className, specName, limit, pages: 4 });
}

// --------------------------------------------------------------------- //
// Auto-detection (so the UI only needs character / server / region)
// --------------------------------------------------------------------- //
const DIFF_ORDER = [5, 4, 3, 2]; // Mythic -> LFR; pick the highest with kills.

// Read class + spec from the character's best kill of an encounter.
// Class/spec the player actually played on a SPECIFIC kill, read from the DamageDone
// table icon (e.g. "Monk-Brewmaster"). Shares the loader's unfiltered table, so this
// detect-phase read doesn't fetch the same kill's table again later.
async function specOfKill(name, code, fight) {
  let data;
  try { data = (await reportCore(code, fight)).dmg.data; } catch (e) { return null; }
  const e = (data.entries || []).find((x) => x.name === name);
  if (!e) return null;
  const icon = String(e.icon || "");
  return { className: e.type, specName: icon.includes("-") ? icon.split("-")[1] : null };
}

async function classSpecFromKill(name, server, region, encounterId, difficulty) {
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  const best = bestRank(er && er.ranks);
  if (!best) return null;
  return specOfKill(name, best.report.code, best.report.fightID);
}

// Highest difficulty the character has kills in, plus their class/spec.
export async function detectContext(name, server, region) {
  let found = null;
  for (const d of DIFF_ORDER) {
    const c = await characterZone(name, server, region, d); // throws if not found
    const killed = (c.zoneRankings.rankings || []).filter(
      (r) => (r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined);
    if (killed.length) { found = { difficulty: d, zr: c.zoneRankings, killed }; break; }
  }
  if (!found) throw new Error(`No ranked kills found for ${name}-${server} (${region}).`);
  // Anchor the spec on the SAME kill the rest of the analysis uses -- bestKill, the
  // most-recent current-gear kill that gear/rotation read. A spec-flexer whose most
  // recent kill is spec B must NOT be detected as spec A off an older high parse:
  // that compares B's casts to A's peers and yields nonsense (e.g. telling an Unholy
  // DK to "press Obliterate" -- a Frost ability the spec doesn't have).
  let cs = null, healerCs = null;
  try {
    const bk = await bestKill(name, server, region, found.difficulty);
    if (bk) {
      const got = await specOfKill(name, bk.code, bk.fight);
      if (got && got.specName) { if (isHealer(got.specName)) healerCs = got; else cs = got; }
    }
  } catch (e) { /* fall through to the per-encounter scan */ }
  // Prefer a DPS/tank spec over a healing one: a player who flexes heal+DPS (e.g. a
  // Holy/Shadow Priest) is analyzed on their DPS spec, not skipped as a healer. Only
  // fall back to a healer spec if that's ALL they ever play.
  if (!cs) {
    for (const r of found.killed) {
      const got = await classSpecFromKill(name, server, region, r.encounter.id, found.difficulty);
      if (!got || !got.specName) continue;
      if (!isHealer(got.specName)) { cs = got; break; }
      healerCs = healerCs || got;
    }
  }
  cs = cs || healerCs;
  if (!cs || !cs.specName) throw new Error("Couldn't determine class/spec from your kills.");
  return { ...found, className: cs.className, specName: cs.specName };
}

// Players you most often appear ALONGSIDE in your own kills -- your raid team.
// Bounded + best-effort: scan a few of your recent kill reports' rosters, tally
// who recurs, return the most frequent (with the realm NAME from the report; the
// caller resolves the slug). Excludes you. Returns [] on any hiccup (private
// reports, rate limit, schema gap) so the picker degrades gracefully.
// Same region as you -- retail raids are within-region.
export async function raidTeammates(name, server, region, { maxReports = 12, top = 24 } = {}) {
  try {
    // Find the highest difficulty you have kills in, and its killed encounters.
    let difficulty = null, killed = [];
    for (const d of DIFF_ORDER) {
      const c = await characterZone(name, server, region, d);
      killed = (c.zoneRankings.rankings || []).filter((r) => (r.totalKills || 0) > 0);
      if (killed.length) { difficulty = d; break; }
    }
    if (!difficulty) return [];
    // Collect distinct recent report codes (= raid nights) from your kills. More
    // reports -> a fuller team and a "shared" count that isn't capped at a tiny
    // sample (the bug: "4 raids together" was just "all 4 of the 4 we checked").
    const codes = [];
    for (const r of killed) {
      if (codes.length >= maxReports) break;
      const er = await characterEncounter(name, server, region, r.encounter.id, difficulty);
      for (const rk of ((er && er.ranks) || [])) {
        const code = rk.report && rk.report.code;
        if (code && !codes.includes(code)) { codes.push(code); if (codes.length >= maxReports) break; }
      }
    }
    if (!codes.length) return [];
    // One light masterData query per report for its player roster. Per the WCL v2
    // schema, ReportActor is `{ name: String, type: String, server: String, ... }`
    // -- server is the realm NAME (a scalar; the {name,region} object is a
    // different type used by rankings). region isn't on the actor, so we use yours
    // (retail raids are within-region).
    const rosters = await mapLimit(codes, 6, async (code) => {
      let actors = [];
      try {
        const q = `query { reportData { report(code:"${code}") { masterData { actors { name server type } } } } }`;
        actors = (await gql(q)).reportData.report.masterData.actors || [];
      } catch { return []; }
      const seen = new Set(), out = [];
      for (const a of actors) {
        if (a.type !== "Player" || !a.name || !a.server) continue;
        const k = `${a.name}|${a.server}`.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k); out.push({ name: a.name, server: a.server });
      }
      return out;
    });
    const of = rosters.filter((r) => r.length).length;   // raids we actually read (the denominator)
    // Tally appearances across reports, excluding yourself.
    const self = name.toLowerCase();
    const tally = new Map();
    for (const roster of rosters) for (const p of roster) {
      if (p.name.toLowerCase() === self) continue;
      const k = `${p.name}|${p.server}`.toLowerCase();
      const e = tally.get(k) || { name: p.name, server: p.server, region, shared: 0, of };
      e.shared++; tally.set(k, e);
    }
    const all = [...tally.values()].sort((a, b) => b.shared - a.shared);
    // Prefer your REGULARS (in >=2 of the scanned raids) over one-off pugs; fall
    // back to all if that's too thin (e.g. only one report could be read).
    const regulars = all.filter((t) => t.shared >= 2);
    return (regulars.length >= 5 ? regulars : all).slice(0, top);
  } catch { return []; }
}

// The gear stat to optimize toward = the one the top field stacks most.
export async function detectPriority(className, specName, difficulty, encounterId, sample = 6) {
  const cands = await collectPeers({ encounters: encounterId, difficulty, className, specName, limit: sample + 3, pages: 4 });
  const stats = await mapLimit(cands, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    return m ? secondaryStats(r.report.code, r.report.fightID, m.sourceID, className) : null;
  });
  const sums = { crit: 0, haste: 0, mastery: 0, vers: 0 };
  let n = 0;
  for (const s of stats) {
    if (!s || n >= sample) continue;
    for (const k of ["crit", "haste", "mastery", "vers"]) sums[k] += s[k];
    n++;
  }
  const keys = ["crit", "haste", "mastery", "vers"];
  return n ? keys.reduce((a, b) => (sums[a] >= sums[b] ? a : b)) : "crit";
}

export function gearSummary(gear, tierSetId = null) {
  const enchanted = new Set();
  for (const g of gear) {
    if (g.slot in ENCHANTABLE_SLOTS && g.permanentEnchant) enchanted.add(ENCHANTABLE_SLOTS[g.slot]);
  }
  const missing = new Set();
  for (const s of Object.keys(ENCHANTABLE_SLOTS)) {
    const nm = ENCHANTABLE_SLOTS[s];
    if (!enchanted.has(nm)) missing.add(nm);
  }
  const trinkets = gear.filter((g) => g.slot === 12 || g.slot === 13).map((g) => g.name);
  let tier = 0;
  for (const g of gear) if (tierSetId && g.setID === tierSetId) tier++;
  return { enchanted, missing, trinkets, tier };
}
