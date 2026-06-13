// @ts-check
// Shared constants, formatting helpers, and low-level WCL fetchers.
// Ported from analyze.py's fetcher layer; imported by the analysis modules.
import { gql } from "./wcl.js";

export const DIFFICULTY = { 2: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic" };

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

// Highest-count [key, count] entry of a Map counter, or null when empty.
export const topEntry = (counter) =>
  (!counter || !counter.size) ? null : [...counter.entries()].sort((a, b) => b[1] - a[1])[0];

export function median(arr) {
  const a = arr.filter((x) => x !== null && x !== undefined && !Number.isNaN(x))
    .slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
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
/** @param {number} lo @param {number} [hi] @returns {Score} */
export const DPS = (lo, hi = lo) => ({ impact: (lo + hi) / 2, label: hi > lo ? `~${lo}-${hi}% DPS` : `~${lo}% DPS` });
/** @param {number} pct @returns {Score} */
export const COMP = (pct) => ({ impact: pct, label: `~${pct}% comp` });
/** @type {Score} */
export const INFO = { impact: 0, label: "info" };
// Assemble one finding: finding("Gear", DPS(1, 3), "STAT via ...").
/** @param {Dim} dim @param {Score} score @param {string} text @returns {Finding} */
export const finding = (dim, score, text) => ({ dim, ...score, text });

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

export async function characterEncounter(name, server, region, encounterId, difficulty) {
  const q = `query { characterData { character(
    name:"${cName(name)}", serverSlug:"${slug(clean(server))}", serverRegion:"${cRegion(region)}") {
    encounterRankings(encounterID:${encounterId}, difficulty:${difficulty}, metric:dps) } } }`;
  const c = (await gql(q)).characterData.character;
  return c ? c.encounterRankings : null;
}

export async function topRankings(encounterId, difficulty, className, specName, page = 1) {
  const q = `query { worldData { encounter(id:${encounterId}) { characterRankings(
    difficulty:${difficulty}, className:"${clean(className)}", specName:"${clean(specName)}", metric:dps, page:${page}) } } }`;
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
  const totalCasts = Object.values(castCounts).reduce((s, v) => s + v, 0);
  return {
    name: e.name, ilvl: e.itemLevel, dur,
    dps: e.total / dur, total: e.total,
    activePct: dmg.totalTime ? 100 * (e.activeTime || 0) / dmg.totalTime : 0,
    targets: (e.targets || []).length,
    // per-target damage totals (for damage-routing / cleave-funnel analysis)
    dmgTargets: e.targets || [],
    casts: castCounts, dmgBy: dmgBy,
    castsPerMin: dur ? totalCasts / (dur / 60) : 0,
    sourceID: e.id, gear: e.gear || [],
  };
}

// Central per-(report, fight) loader: ONE query for the damage + cast tables, the
// CombatantInfo events (secondary stats), and the fight window. The tables are
// fetched UNFILTERED (no sourceClass) -- consumers pick their player by name in
// metricsFromTables -- so a kill's DamageDone/Casts is fetched exactly ONCE no
// matter who asks or what class filter they'd otherwise use. WCL bills ~flat per
// request, so one bundled fetch per report+fight is the structural point saving.
// Memoized by query string via the gql cache; the loader test enforces "each
// table once per report". No className: the data is identical for every caller.
export async function reportCore(code, fight) {
  const q = `query { reportData { report(code:"${code}") {
    dmg: table(fightIDs:${fight}, dataType:DamageDone)
    casts: table(fightIDs:${fight}, dataType:Casts)
    combatant: events(fightIDs:${fight}, dataType:CombatantInfo, limit:50) { data }
    fightWin: fights(fightIDs:${fight}) { startTime endTime } } } }`;
  return (await gql(q)).reportData.report;
}

// Damage + cast metrics for one player on one fight (className arg ignored -- the
// loader is unfiltered; kept for call-site compatibility).
export async function playerMetrics(code, fight, name, specName, className) {
  const d = await reportCore(code, fight);
  return metricsFromTables(d.dmg.data, d.casts.data, name, specName);
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
export async function fightEvents(code, fight, sourceId, start, end) {
  const win = `, startTime: ${start}, endTime: ${end}`;
  const q = `query { reportData { report(code:"${code}") {
    casts: events(fightIDs:${fight}, sourceID:${sourceId}, dataType:Casts, limit:10000${win}) { data nextPageTimestamp }
    autos: events(fightIDs:${fight}, sourceID:${sourceId}, dataType:DamageDone, abilityID:1, limit:10000${win}) { data nextPageTimestamp } } } }`;
  const r = (await gql(q)).reportData.report;
  let casts = r.casts.data, autos = r.autos.data;
  if (r.casts.nextPageTimestamp) casts = casts.concat(await paginateEvents(code, fight, sourceId, "Casts", null, r.casts.nextPageTimestamp, end));
  if (r.autos.nextPageTimestamp) autos = autos.concat(await paginateEvents(code, fight, sourceId, "DamageDone", 1, r.autos.nextPageTimestamp, end));
  if (!autos.length) autos = await paginateEvents(code, fight, sourceId, "DamageDone", 75, start, end);
  return { casts: casts.filter((e) => !e.fake), autos };
}

// Self-buff uptime % keyed by buff name (match by keyword to compare).
export async function buffUptimes(code, fight, sourceId) {
  const q = `query { reportData { report(code:"${code}") {
    table(fightIDs:${fight}, dataType:Buffs, sourceID:${sourceId}) } } }`;
  const d = (await gql(q)).reportData.report.table.data;
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
export const bestRank = (ranks) => {
  if (!ranks || !ranks.length) return null;
  const maxIl = Math.max(...ranks.map((r) => r.bracketData || 0));
  return ranks.filter((r) => (r.bracketData || 0) >= maxIl - RECENT_ILVL_BAND)
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

// --------------------------------------------------------------------- //
// Auto-detection (so the UI only needs character / server / region)
// --------------------------------------------------------------------- //
const DIFF_ORDER = [5, 4, 3, 2]; // Mythic -> LFR; pick the highest with kills.

// Read class + spec from the character's best kill of an encounter.
async function classSpecFromKill(name, server, region, encounterId, difficulty) {
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  const best = bestRank(er && er.ranks);
  if (!best) return null;
  // Share the loader's unfiltered DamageDone table -- so this detect-phase read
  // doesn't fetch the same kill's table again later.
  let data;
  try { data = (await reportCore(best.report.code, best.report.fightID)).dmg.data; } catch (e) { return null; }
  const e = (data.entries || []).find((x) => x.name === name);
  if (!e) return null;
  const icon = String(e.icon || ""); // e.g. "Monk-Brewmaster"
  return { className: e.type, specName: icon.includes("-") ? icon.split("-")[1] : null };
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
  let cs = null;
  for (const r of found.killed) {
    cs = await classSpecFromKill(name, server, region, r.encounter.id, found.difficulty);
    if (cs && cs.specName) break;
  }
  if (!cs || !cs.specName) throw new Error("Couldn't determine class/spec from your kills.");
  return { ...found, className: cs.className, specName: cs.specName };
}

// Players you most often appear ALONGSIDE in your own kills -- your raid team.
// Bounded + best-effort: scan a few of your recent kill reports' rosters, tally
// who recurs, return the most frequent (with the realm NAME from the report; the
// caller resolves the slug). Excludes you. Returns [] on any hiccup (private
// reports, rate limit, schema gap) so the picker degrades gracefully.
// Same region as you -- retail raids are within-region.
export async function raidTeammates(name, server, region, { maxReports = 4, top = 6 } = {}) {
  try {
    // Find the highest difficulty you have kills in, and its killed encounters.
    let difficulty = null, killed = [];
    for (const d of DIFF_ORDER) {
      const c = await characterZone(name, server, region, d);
      killed = (c.zoneRankings.rankings || []).filter((r) => (r.totalKills || 0) > 0);
      if (killed.length) { difficulty = d; break; }
    }
    if (!difficulty) return [];
    // Collect a few distinct recent report codes from your kills.
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
    const rosters = await mapLimit(codes, 4, async (code) => {
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
    // Tally appearances across reports, excluding yourself.
    const self = name.toLowerCase();
    const tally = new Map();
    for (const roster of rosters) for (const p of roster) {
      if (p.name.toLowerCase() === self) continue;
      const k = `${p.name}|${p.server}`.toLowerCase();
      const e = tally.get(k) || { name: p.name, server: p.server, region, shared: 0 };
      e.shared++; tally.set(k, e);
    }
    return [...tally.values()].sort((a, b) => b.shared - a.shared).slice(0, top);
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
