// Talent build vs the field. WCL's CombatantInfo carries a `talentTree` --
// [{id, rank, nodeID}] -- so we compare YOUR chosen talent nodes against what
// the ilvl/spec field actually runs on a boss, and flag the meta talents you're
// missing + your off-meta picks.
//
// NAMING: WCL's talentTree ids are NOT Wowhead spell ids (id 102476 resolves to
// "Summon Garrosh"). The mapping is exact, though, against Raidbots' public
// talents.json (no token, CORS-open, ~monthly cache): WCL `nodeID` === Raidbots
// node `id`, and WCL `id` === Raidbots entry `id`, which carries the real name +
// spellId. We match the spec by CombatantInfo.specID === Raidbots specId.
import { reportCore, playerMetrics, collectPeers, mapLimit, f, bestKill, DPS, finding } from "./core.js";
import { wowheadSpell } from "./links.js";

const TALENTS_URL = "https://www.raidbots.com/static/data/live/talents.json";

// --- pure, unit-tested helpers ----------------------------------------------

// Build name lookups for one spec from a Raidbots spec object: nodeID -> name,
// and entryID -> {name, spellId}. Pure so it's testable without the network.
export function buildTalentIndex(spec) {
  const byEntry = new Map(), byNode = new Map();
  if (!spec) return { byEntry, byNode };
  const nodes = [...(spec.classNodes || []), ...(spec.specNodes || []),
                 ...(spec.heroNodes || []), ...(spec.subTreeNodes || [])];
  for (const n of nodes) {
    if (n.name) byNode.set(n.id, n.name);
    for (const e of (n.entries || [])) if (e.id) byEntry.set(e.id, { name: e.name, spellId: e.spellId });
  }
  return { byEntry, byNode };
}

// Name + spell link target for a taken node: prefer the node name (correct for
// single nodes and clear for choice nodes), take the spellId from the entry the
// player/field actually picked.
export function talentLabel(index, nodeID, entryId) {
  const ent = index.byEntry.get(entryId);
  return { name: index.byNode.get(nodeID) || (ent && ent.name) || `talent ${entryId}`,
           spellId: ent ? ent.spellId : null };
}

// Compare your nodes to field adoption counts. Returns the meta talents you lack
// (>= missThresh of the field) and your off-meta picks (<= offThresh).
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

// --- data layer --------------------------------------------------------------

// Raidbots talents.json (all specs, ~3MB) -- fetched once per session, then the
// per-spec index is cached in localStorage so reloads skip the big download.
let _rbPromise = null;
function rbTalents() {
  if (!_rbPromise) {
    _rbPromise = fetch(TALENTS_URL, { signal: AbortSignal.timeout(45000) })
      .then((r) => r.json())
      .catch(() => null);
  }
  return _rbPromise;
}

const _indexCache = new Map(); // specID -> {byEntry, byNode}
export async function talentIndex(specID) {
  if (_indexCache.has(specID)) return _indexCache.get(specID);
  const ck = "talentidx:" + specID;
  let idx = null;
  try {
    const c = localStorage.getItem(ck);
    if (c) { const o = JSON.parse(c); idx = { byEntry: new Map(o.e), byNode: new Map(o.n) }; }
  } catch (e) { /* fall through to fetch */ }
  if (!idx) {
    const data = await rbTalents();
    const spec = Array.isArray(data) ? data.find((s) => s.specId === specID) : null;
    idx = buildTalentIndex(spec);
    try { localStorage.setItem(ck, JSON.stringify({ e: [...idx.byEntry], n: [...idx.byNode] })); } catch (e) { /* ignore */ }
  }
  _indexCache.set(specID, idx);
  return idx;
}

// Your taken talent nodes on one fight: { map: Map(nodeID -> {id, rank}), specID }.
// Reads CombatantInfo from the shared report loader (reportCore), so it reuses
// the one fetch the rest of the analysis already made instead of re-querying.
async function loadout(code, fight, sourceId) {
  let data;
  try { data = (await reportCore(code, fight)).combatant.data; } catch (e) { return null; }
  const e = data.find((x) => x.sourceID === sourceId);
  if (!e || !Array.isArray(e.talentTree)) return null;
  const map = new Map();
  for (const t of e.talentTree) if (t.nodeID) map.set(t.nodeID, { id: t.id, rank: t.rank || 1 });
  return { map, specID: e.specID };
}

async function fieldLoadouts(encounterId, difficulty, className, specName, n = 10) {
  const cands = await collectPeers({ encounters: encounterId, difficulty, className, specName, limit: n + 3, pages: 4 });
  const outs = await mapLimit(cands, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    const lo = m ? await loadout(r.report.code, r.report.fightID, m.sourceID) : null;
    return lo ? lo.map : null;
  });
  return outs.filter(Boolean).slice(0, n);
}

// --- findings (data the prescription + card consume) -------------------------

// Named talent findings vs the field on your benchmark boss. Returns null when
// there isn't enough data (no kills, no peer loadouts).
export async function talentFindings(name, server, region, className, specName, difficulty) {
  const best = await bestKill(name, server, region, difficulty);
  if (!best) return null;
  const pm = await playerMetrics(best.code, best.fight, name, specName, className);
  if (!pm) return null;
  const you = await loadout(best.code, best.fight, pm.sourceID);
  if (!you) return null;
  const peers = await fieldLoadouts(best.encounter.id, difficulty, className, specName);
  if (!peers.length) return null;

  const fieldCount = new Map(); // nodeID -> {count, id}
  for (const lo of peers) for (const [node, info] of lo) {
    const cur = fieldCount.get(node) || { count: 0, id: info.id };
    cur.count++; fieldCount.set(node, cur);
  }
  const d = talentDiff(you.map, fieldCount, peers.length);
  const idx = await talentIndex(you.specID);
  const named = (t) => ({ ...t, ...talentLabel(idx, t.node, t.id) });
  return {
    boss: best.encounter.name, nPeers: peers.length, matched: d.matched, metaTotal: d.metaTotal,
    missing: d.missing.map(named), offMeta: d.offMeta.map(named),
  };
}

// Prescription lever: the meta talents most of the field takes on THIS boss that
// you don't -- a "switch your build for this fight" item. Sized by how widely the
// field adopts them (an estimate; talent DPS value needs a sim).
export function talentLevers(tf) {
  const top = tf ? tf.missing.filter((t) => t.adopt >= 0.6).slice(0, 3) : [];
  if (!top.length) return [];
  const est = Math.min(2 + top.length, 6);
  return [finding("Rotation", DPS(est),
    `TALENTS: peers on ${tf.boss} take ${top.map((t) => `${wowheadSpell(t.spellId, t.name)} (${f(100 * t.adopt, 0)}%)`).join(", ")} ` +
    `that you don't -- swap to the meta build for this content (confirm in a sim/guide).`)];
}

// --- card output -------------------------------------------------------------

const link = (spellId, name) => (spellId ? `[${name}](https://www.wowhead.com/spell=${spellId})` : name);

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster", difficulty = 5) {
  const fnd = await talentFindings(name, server, region, className, specName, difficulty);
  if (!fnd) { log("(couldn't read your talents or the field's)"); return; }

  log(`=== Talents vs ${fnd.nPeers} top ${specName}s on ${fnd.boss} ===`);
  log(`Your build matches ${fnd.matched}/${fnd.metaTotal} of the talents your peers commonly take.`);
  if (fnd.missing.length) {
    log("");
    log("Meta talents you're MISSING (peers take them on this boss, you don't):");
    for (const t of fnd.missing.slice(0, 8)) log(`  - ${link(t.spellId, t.name)} — ${f(100 * t.adopt, 0)}% of peers`);
  }
  if (fnd.offMeta.length) {
    log("");
    log("Off-meta picks (few peers run these here — worth re-checking):");
    for (const t of fnd.offMeta.slice(0, 6)) log(`  - ${link(t.spellId, t.name)} — only ${f(100 * t.adopt, 0)}% of peers`);
  }
  if (!fnd.missing.length && !fnd.offMeta.length) {
    log("");
    log("Your talent build lines up with your peers on this boss — no obvious swaps.");
  }
}
