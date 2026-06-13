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

export function median(arr) {
  const a = arr.filter((x) => x !== null && x !== undefined && !Number.isNaN(x))
    .slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// --------------------------------------------------------------------- //
// Low-level fetchers
// --------------------------------------------------------------------- //
export async function characterZone(name, server, region, difficulty) {
  const q = `query { characterData { character(
    name:"${clean(name)}", serverSlug:"${slug(clean(server))}", serverRegion:"${clean(region)}") {
    id classID zoneRankings(difficulty:${difficulty}) } } }`;
  const c = (await gql(q)).characterData.character;
  if (!c) throw new Error(`Character not found: ${name}-${server}-${region}`);
  return c;
}

export async function characterEncounter(name, server, region, encounterId, difficulty) {
  const q = `query { characterData { character(
    name:"${clean(name)}", serverSlug:"${slug(clean(server))}", serverRegion:"${clean(region)}") {
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

function entry(tableData, name, specName) {
  const entries = tableData.entries || [];
  let hit = entries.filter((e) => e.name === name);
  if (!hit.length) hit = entries.filter((e) => specName && String(e.icon || "").includes(specName));
  return hit.length ? hit[0] : null;
}

// Damage + cast metrics for one player on one fight.
export async function playerMetrics(code, fight, name, specName, className = "Monk") {
  const q = `query { reportData { report(code:"${code}") {
    dmg: table(fightIDs:${fight}, dataType:DamageDone, sourceClass:"${className}")
    casts: table(fightIDs:${fight}, dataType:Casts, sourceClass:"${className}") } } }`;
  const d = (await gql(q)).reportData.report;
  const dmg = d.dmg.data, casts = d.casts.data;
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
    active_pct: dmg.totalTime ? 100 * (e.activeTime || 0) / dmg.totalTime : 0,
    targets: (e.targets || []).length,
    casts: castCounts, dmg_by: dmgBy,
    casts_per_min: dur ? totalCasts / (dur / 60) : 0,
    sourceID: e.id, gear: e.gear || [],
  };
}

// Self-buff uptime % keyed by buff name (match by keyword to compare).
export async function buffUptimes(code, fight, sourceId) {
  const q = `query { reportData { report(code:"${code}") {
    table(fightIDs:${fight}, dataType:Buffs, sourceID:${sourceId}) } } }`;
  const d = (await gql(q)).reportData.report.table.data;
  const tt = d.totalTime;
  const out = {};
  for (const a of d.auras) if (tt) out[a.name] = 100 * (a.totalUptime || 0) / tt;
  return out;
}

// Crit/haste/mastery/vers ratings from CombatantInfo events.
export async function secondaryStats(code, fight, sourceId) {
  const q = `query { reportData { report(code:"${code}") { events(
    fightIDs:${fight}, dataType:CombatantInfo, limit:50) { data } } } }`;
  for (const e of (await gql(q)).reportData.report.events.data) {
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
// Auto-detection (so the UI only needs character / server / region)
// --------------------------------------------------------------------- //
const DIFF_ORDER = [5, 4, 3, 2]; // Mythic -> LFR; pick the highest with kills.

// Read class + spec from the character's best kill of an encounter.
async function classSpecFromKill(name, server, region, encounterId, difficulty) {
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  if (!er || !er.ranks || !er.ranks.length) return null;
  const best = er.ranks.reduce((a, b) => ((a.bracketData || 0) >= (b.bracketData || 0) ? a : b));
  const q = `query { reportData { report(code:"${best.report.code}") {
    table(fightIDs:${best.report.fightID}, dataType:DamageDone) } } }`;
  let data;
  try { data = (await gql(q)).reportData.report.table.data; } catch (e) { return null; }
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

// The gear stat to optimize toward = the one the top field stacks most.
export async function detectPriority(className, specName, difficulty, encounterId, sample = 6) {
  const sums = { crit: 0, haste: 0, mastery: 0, vers: 0 };
  let n = 0;
  for (let page = 1; page <= 4 && n < sample; page++) {
    for (const r of await topRankings(encounterId, difficulty, className, specName, page)) {
      if (n >= sample) break;
      try {
        const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
        if (!m) continue;
        const s = await secondaryStats(r.report.code, r.report.fightID, m.sourceID);
        if (!s) continue;
        for (const k of ["crit", "haste", "mastery", "vers"]) sums[k] += s[k];
        n++;
      } catch (e) { continue; }
    }
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
