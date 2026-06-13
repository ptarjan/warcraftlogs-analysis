// Talent build vs the field. WCL's CombatantInfo carries a `talentTree` --
// [{id, rank, nodeID}] -- so we compare YOUR chosen talent nodes against what
// the ilvl/spec field actually runs, and flag the meta talents you're missing +
// your off-meta picks.
//
// STATUS: NOT WIRED IN. The loadout DIFF (talentDiff) is correct and tested, but
// talentTree[].id is NOT a usable Wowhead spell id -- it resolves to unrelated /
// placeholder spells (cross-class abilities, "Sad", "Quest - Deep Breath
// Targetting"), so the per-talent names/links are wrong. BLOCKED on a proper
// node->talent name/spell mapping (a talent-tree definition, e.g. from Wowhead's
// talent-calc data or Blizzard's talent-tree API). Until then we don't show this
// to users. spellName()/the /spell route are ready for when the mapping lands.
import { gql } from "./wcl.js";
import { spellTooltip } from "./wcl.js";
import {
  playerMetrics, topRankings, mapLimit, f, bestKill,
} from "./core.js";

// Your taken talent nodes on one fight: Map(nodeID -> {id, rank}).
async function loadout(code, fight, sourceId) {
  const q = `query { reportData { report(code:"${code}") { events(
    fightIDs:${fight}, dataType:CombatantInfo, limit:50) { data } } } }`;
  let data;
  try { data = (await gql(q)).reportData.report.events.data; } catch (e) { return null; }
  const e = data.find((x) => x.sourceID === sourceId);
  if (!e || !Array.isArray(e.talentTree)) return null;
  const m = new Map();
  for (const t of e.talentTree) if (t.nodeID) m.set(t.nodeID, { id: t.id, rank: t.rank || 1 });
  return m;
}

// Pure: compare your nodes to field adoption counts. Returns the meta talents
// you lack (>= missThresh of the field) and your off-meta picks (<= offThresh).
export function talentDiff(youSet, fieldCount, fieldN, missThresh = 0.6, offThresh = 0.25) {
  const missing = [], offMeta = [];
  let metaTotal = 0, matched = 0;
  for (const [node, info] of fieldCount) {
    const adopt = info.count / fieldN;
    if (adopt >= missThresh) {
      metaTotal++;
      if (youSet.has(node)) matched++;
      else missing.push({ node, id: info.id, adopt });
    }
  }
  for (const node of youSet.keys()) {
    const fc = fieldCount.get(node);
    const adopt = fc ? fc.count / fieldN : 0;
    if (adopt <= offThresh) offMeta.push({ node, id: youSet.get(node).id, adopt });
  }
  missing.sort((a, b) => b.adopt - a.adopt);
  offMeta.sort((a, b) => a.adopt - b.adopt);
  return { missing, offMeta, metaTotal, matched };
}


async function fieldLoadouts(encounterId, difficulty, className, specName, n = 10) {
  const cands = [];
  for (let page = 1; page <= 4 && cands.length < n + 3; page++) {
    for (const r of await topRankings(encounterId, difficulty, className, specName, page)) {
      cands.push(r);
      if (cands.length >= n + 3) break;
    }
  }
  const outs = await mapLimit(cands, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    return m ? loadout(r.report.code, r.report.fightID, m.sourceID) : null;
  });
  return outs.filter(Boolean).slice(0, n);
}

// Spell name (Wowhead, cached) for nicer labels; falls back to the id.
async function spellName(id) {
  const key = "spell:" + id;
  try { const c = localStorage.getItem(key); if (c) return c; } catch (e) { /* ignore */ }
  let name = `spell ${id}`;
  try { const d = await spellTooltip(id); if (d && d.name) name = d.name; } catch (e) { /* ignore */ }
  try { localStorage.setItem(key, name); } catch (e) { /* ignore */ }
  return name;
}
const link = (id, name) => `[${name}](https://www.wowhead.com/spell=${id})`;

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster", difficulty = 5) {
  const best = await bestKill(name, server, region, difficulty);
  if (!best) { log("(no kills found to read your talents from)"); return; }
  const you = await loadout(best.code, best.fight, (await playerMetrics(best.code, best.fight, name, specName, className) || {}).sourceID);
  if (!you) { log("(couldn't read your talent loadout)"); return; }

  const peers = await fieldLoadouts(best.encounter.id, difficulty, className, specName);
  if (!peers.length) { log("(no peer talent data found)"); return; }

  const fieldCount = new Map(); // nodeID -> {count, id}
  for (const lo of peers) for (const [node, info] of lo) {
    const cur = fieldCount.get(node) || { count: 0, id: info.id };
    cur.count++; fieldCount.set(node, cur);
  }

  const d = talentDiff(you, fieldCount, peers.length);
  log("");
  log(`=== Talents vs ${peers.length} ilvl-matched ${specName}s ===`);
  log(`Your build matches ${d.matched}/${d.metaTotal} of your peers' commonly-taken talents.`);

  if (d.missing.length) {
    log("");
    log("Meta talents you're MISSING (peers take, you don't):");
    for (const t of d.missing.slice(0, 8)) {
      log(`  - ${link(t.id, await spellName(t.id))} — ${f(100 * t.adopt, 0)}% of peers`);
    }
  }
  if (d.offMeta.length) {
    log("");
    log("Off-meta picks (few peers run these — worth re-checking):");
    for (const t of d.offMeta.slice(0, 6)) {
      log(`  - ${link(t.id, await spellName(t.id))} — only ${f(100 * t.adopt, 0)}% of peers`);
    }
  }
  if (!d.missing.length && !d.offMeta.length) {
    log("");
    log("Your talent build lines up with your peers — no obvious swaps.");
  }
}
