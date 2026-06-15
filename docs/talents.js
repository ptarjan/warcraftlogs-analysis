// @ts-check
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
import { spellTooltip } from "./wcl.js";
import { reportCore, playerMetrics, topField, mapLimit, median, topN, f, bestKill, DPS, finding, DIM, KIND, metricUnit, throughputWord } from "./core.js";
import { wowheadSpell } from "./links.js";

const TALENTS_URL = "https://www.raidbots.com/static/data/live/talents.json";

// --- pure, unit-tested helpers ----------------------------------------------

// Build name lookups for one spec from a Raidbots spec object: nodeID -> name,
// and entryID -> {name, spellId}. Also map the HERO SUBTREE: which choice node
// picks the hero tree, each hero-entry id -> tree name, and the full set of nodes
// that belong to either hero tree (so the diff can treat them as ONE either/or
// choice, not N independent "missing" talents). Pure so it's testable.
export function buildTalentIndex(spec) {
  const byEntry = new Map(), byNode = new Map(), heroByEntry = new Map(), heroNodes = new Set();
  let heroChoice = null;
  if (!spec) return { byEntry, byNode, heroByEntry, heroNodes, heroChoice };
  const nodes = [...(spec.classNodes || []), ...(spec.specNodes || []),
                 ...(spec.heroNodes || []), ...(spec.subTreeNodes || [])];
  for (const n of nodes) {
    if (n.name) byNode.set(n.id, n.name);
    for (const e of (n.entries || [])) {
      if (e.id) byEntry.set(e.id, { name: e.name, spellId: e.spellId });
      if (e.type === "subtree" && Array.isArray(e.nodes)) { // a hero-tree choice
        heroChoice = n.id;
        heroByEntry.set(e.id, e.name);
        for (const nid of e.nodes) heroNodes.add(nid);
      }
    }
  }
  return { byEntry, byNode, heroByEntry, heroNodes, heroChoice };
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

// "90% of the field takes it" does NOT mean a talent adds damage -- the field
// also unanimously takes mandatory UTILITY (Detox = dispel, Typhoon = knockback,
// Tiger Tail Sweep = stun range) and DEFENSIVES. The tooltip is the discriminator.
//
// A talent adds damage when it carries a STRONG offensive marker: a damage
// coefficient ("(200% of attack power)"), "increased/additional damage", "damage
// dealt/done", a flat "deals N", or it raises a throughput stat. We require that
// (not merely the word "damage") and first strip purely-defensive phrases, so
// "reduces damage taken" can't read as offense. Validated against ALL 39 specs'
// tooltips (3239 talents): a 2-spec sample had it backwards -- it vetoed any
// talent mentioning "heal"/"absorb", wrongly dropping hybrid damage+heal talents
// (Engulfing Blaze, Liveliness, Fulminous Roar -- common on Evoker/Druid/Priest).
// Pure + tested so it needs no network.
export function looksLikeDpsTalent(tooltipText) {
  const t = String(tooltipText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
  const off = t.replace(/damage (taken|reduction)|(reduces?|reducing|less)[^.]{0,40}damage|damage[^.]{0,20}(reduced|taken)/g, " ");
  const dpsy = /% of (attack|spell) power|(increased|additional|extra|bonus) damage|damage (dealt|done)|deals?\s+\d|inflicts?\s+\d|increases?[^.]{0,40}(damage|critical strike|\bcrit\b|\bhaste\b|mastery|versatil|attack power|spell power|\bagility\b|\bstrength\b|\bintellect\b)|\d+%[^.]{0,30}\bdamage\b/.test(off);
  if (!dpsy) return false;
  // HEALING/absorb effects scale with Spell Power too ("231% of Spell Power" of HEALING),
  // so the "% of spell power" / stat cues above misfire on them -- Chain Heal and Earth
  // Shield read as DPS talents and got recommended to a DPS player as a respec. A talent
  // that heals/absorbs but never DEALS damage is utility, not throughput. (Detect heals by
  // "heal/healing/absorb" -- NOT "shield", which is in DPS ability names like Shield of the
  // Righteous; hybrids that both heal AND deal damage keep their damage clause and stay in.)
  const heals = /\bheals?\b|\bhealing\b|\babsorbs?\b/.test(t);
  const dealsDamage = /\b(deal|deals|dealing|inflict|inflicts|inflicting)\b[^.]{0,40}\bdamage\b|damage (dealt|done)|(increased|additional|extra|bonus) damage/.test(off);
  return !(heals && !dealsDamage);
}

// Does a talent (by spell id) add damage? Reads the Wowhead tooltip, classifies
// with looksLikeDpsTalent, caches the boolean per spell so it's read once.
const _dpsCache = new Map();
async function isDpsTalent(spellId) {
  if (!spellId) return false;
  if (_dpsCache.has(spellId)) return _dpsCache.get(spellId);
  const ck = "taldps3:" + spellId; // "3" re-classifies past v2 entries that mislabeled Spell-Power HEALS (Chain Heal/Earth Shield) as DPS
  try { const c = localStorage.getItem(ck); if (c !== null && c !== undefined) { const v = c === "1"; _dpsCache.set(spellId, v); return v; } } catch (e) { /* ignore */ }
  let dps = false;
  try { const d = await spellTooltip(spellId); dps = looksLikeDpsTalent(d && d.tooltip); } catch (e) { dps = false; }
  _dpsCache.set(spellId, dps);
  try { localStorage.setItem(ck, dps ? "1" : "0"); } catch (e) { /* ignore */ }
  return dps;
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

const _indexCache = new Map(); // specID -> {byEntry, byNode, heroByEntry, heroNodes, heroChoice}
export async function talentIndex(specID) {
  if (_indexCache.has(specID)) return _indexCache.get(specID);
  const ck = "talentidx2:" + specID; // "2" adds hero-subtree fields
  let idx = null;
  try {
    const c = localStorage.getItem(ck);
    if (c) {
      const o = JSON.parse(c);
      idx = { byEntry: new Map(o.e), byNode: new Map(o.n),
              heroByEntry: new Map(o.hb || []), heroNodes: new Set(o.hn || []), heroChoice: o.hc || null };
    }
  } catch (e) { /* fall through to fetch */ }
  if (!idx) {
    const data = await rbTalents();
    const spec = Array.isArray(data) ? data.find((s) => s.specId === specID) : null;
    idx = buildTalentIndex(spec);
    try {
      localStorage.setItem(ck, JSON.stringify({ e: [...idx.byEntry], n: [...idx.byNode],
        hb: [...idx.heroByEntry], hn: [...idx.heroNodes], hc: idx.heroChoice }));
    } catch (e) { /* ignore */ }
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

// Each field kill's talent map PLUS its per-ability damage (dmgBy) and total -- so a
// missing DAMAGE talent can be priced by the field's MEASURED damage share from it
// (the ability's damage / their total), which is unconfounded, instead of a guess.
async function fieldLoadouts(encounterId, difficulty, className, specName, n = 10) {
  const cands = await topField(className, specName, difficulty, encounterId, n + 3);
  const outs = await mapLimit(cands, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    const lo = m ? await loadout(r.report.code, r.report.fightID, m.sourceID) : null;
    return (m && lo) ? { map: lo.map, dmgBy: m.dmgBy, total: m.total } : null;
  });
  return outs.filter(Boolean).slice(0, n);
}

// MEASURED value of taking a damage talent: among field peers who run it, the
// median share of their total damage that the talent's ability deals. That IS what
// the talent is worth on your parse, read straight from the logs -- no sim, no
// confound (it's the ability's own damage, not "good players take it"). null for a
// passive/buff talent (no matching damage ability) or too few peers -> keep the est.
export function talentDamageShare(peers, node, abilityName, { minPeers = 3 } = {}) {
  if (!abilityName) return null;
  const shares = [];
  for (const p of peers || []) {
    if (!p.map.has(node) || !(p.total > 0) || !p.dmgBy) continue;
    const dmg = p.dmgBy[abilityName] || 0;
    if (dmg > 0) shares.push(100 * dmg / p.total);
  }
  return shares.length >= minPeers ? median(shares) : null;
}

// The abilities a player has TALENTED on a fight, plus the full set of ability
// names that EXIST as talents in their spec. The two together let a caller tell
// three cases apart for an ability the field presses but the player doesn't:
//   - in `taken`     -> they specced it but don't press it (a build/usage problem)
//   - in `universe`  -> it's a talent they skipped (respec to pick it up)
//   - in neither     -> it's BASELINE (e.g. Shield of the Righteous) -- they have
//                       it, they're just not pressing it (a rotation problem, NOT
//                       a missing talent). This is the SotR over-reach guard.
// Returns null when talent data is unavailable (no CombatantInfo / Raidbots).
export async function talentedAbilities(code, fight, sourceId) {
  const you = await loadout(code, fight, sourceId);
  if (!you) return null;
  const idx = await talentIndex(you.specID);
  const universe = new Set();
  for (const n of idx.byNode.values()) if (n) universe.add(n);
  for (const e of idx.byEntry.values()) if (e && e.name) universe.add(e.name);
  const taken = new Set();
  for (const [node, info] of you.map) {
    const { name } = talentLabel(idx, node, info.id);
    if (name) taken.add(name);
  }
  return { taken, universe };
}

// The hero tree a player ran on one fight (e.g. "Elune's Chosen"), or null if
// unknowable (no CombatantInfo/Raidbots, or a spec with no hero choice). Lets a
// caller compare you only to peers on the SAME hero tree: two trees routinely
// swap whole buttons, so a mixed field makes the cast-rate diff lie -- an Elune's
// Chosen Guardian looks like they "over-press" Thrash next to a Druid-of-the-Claw
// field that replaced Thrash with Ravage.
export async function heroTreeOf(code, fight, sourceId) {
  const you = await loadout(code, fight, sourceId);
  if (!you) return null;
  const idx = await talentIndex(you.specID);
  if (!idx.heroChoice) return null;
  const pick = you.map.get(idx.heroChoice);
  return pick ? idx.heroByEntry.get(pick.id) || null : null;
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
  const idx = await talentIndex(you.specID);

  // Hero trees (e.g. Master of Harmony vs Shado-Pan) are ONE mutually-exclusive
  // choice -- picking one means "missing" every node of the other. So pull hero
  // nodes OUT of the per-talent diff and compare the hero CHOICE on its own.
  const heroNodes = idx.heroNodes || new Set();
  const heroName = (lo) => {
    const pick = idx.heroChoice && lo.get(idx.heroChoice);
    return pick ? idx.heroByEntry.get(pick.id) || null : null;
  };
  const heroCounts = new Map();
  for (const p of peers) { const h = heroName(p.map); if (h) heroCounts.set(h, (heroCounts.get(h) || 0) + 1); }
  const heroField = topN(heroCounts)
    .map(([name, ct]) => ({ name, pct: 100 * ct / peers.length }));
  const hero = heroField.length ? { yours: heroName(you.map), field: heroField } : null;

  // Per-talent diff on the NON-hero nodes only.
  const fieldCount = new Map(); // nodeID -> {count, id}
  for (const p of peers) for (const [node, info] of p.map) {
    if (heroNodes.has(node)) continue;
    const cur = fieldCount.get(node) || { count: 0, id: info.id };
    cur.count++; fieldCount.set(node, cur);
  }
  const youReg = new Map([...you.map].filter(([node]) => !heroNodes.has(node)));
  const d = talentDiff(youReg, fieldCount, peers.length);
  // Name each node, tag whether it's a DPS talent (vs utility/defensive) so we only
  // recommend throughput, and MEASURE a damage talent's value = the field's damage
  // share from its ability (unconfounded; null for passives -> caller keeps the est).
  const tag = async (t) => {
    const n = { ...t, ...talentLabel(idx, t.node, t.id) };
    n.dps = await isDpsTalent(n.spellId);
    n.value = n.dps ? talentDamageShare(peers, t.node, n.name) : null;
    return n;
  };
  const missing = await mapLimit(d.missing, 5, tag);
  const offMeta = await mapLimit(d.offMeta, 5, tag);
  return {
    boss: best.encounter.name, nPeers: peers.length, matched: d.matched, metaTotal: d.metaTotal,
    hero, missing, offMeta,
  };
}

// Should we suggest a HERO-TREE switch? A high bar (a strong majority, not a
// 60/40 small-sample wobble) -- a hero tree is one big either/or choice, and a
// 10-peer sample on one boss can easily skew the minority tree, so we only call
// it when the field overwhelmingly runs the other one. Returns the field's
// dominant tree, or null.
export function heroSwitch(hero, { minPct = 80 } = {}) {
  if (!hero || !hero.yours || !(hero.field && hero.field.length)) return null;
  const top = hero.field[0];
  return (top.name !== hero.yours && top.pct >= minPct) ? top : null;
}

// Prescription levers from the talent comparison: a hero-tree switch (only when
// overwhelming) and the meta DAMAGE talents the field takes that you don't.
export function talentLevers(tf) {
  const out = [];
  const sw = tf && heroSwitch(tf.hero);
  if (sw) {
    out.push(finding(DIM.ROTATION, DPS(4),
      `HERO TREE: ${f(sw.pct, 0)}% of the field runs ${sw.name} -- you run ${tf.hero.yours}. That's one big either/or build choice; confirm it's the meta for your spec (sim/guide) before switching.`,
      "est", KIND.HERO_TREE));
  }
  // DPS talents only -- never recommend respeccing for a dispel/knockback the
  // field happens to take unanimously.
  const top = tf ? tf.missing.filter((t) => t.dps && t.adopt >= 0.6).slice(0, 3) : [];
  if (top.length) {
    // MEASURED when we could read each talent's field damage share; sum them (you'd
    // gain roughly that share). Else the old flat estimate. Honestly tagged either way.
    const measured = top.map((t) => t.value).filter((v) => v != null);
    const allMeasured = measured.length === top.length;
    const pct = allMeasured ? Math.max(1, Math.round(measured.reduce((a, b) => a + b, 0))) : Math.min(2 + top.length, 6);
    const cite = allMeasured
      ? ` (measured: ${top.map((t) => `${t.name} is ${f(t.value, 1)}% of the field's damage`).join(", ")})`
      : "";
    out.push(finding(DIM.ROTATION, DPS(pct),
      `TALENTS: peers on ${tf.boss} take the ${throughputWord()} talent${top.length > 1 ? "s" : ""} ${top.map((t) => `${wowheadSpell(t.spellId, t.name)} (${f(100 * t.adopt, 0)}%)`).join(", ")} ` +
      `that you don't -- swap to the meta build for this content (confirm in a sim/guide).${cite}`,
      allMeasured ? "measured" : "est", KIND.TALENTS));
  }
  return out;
}

// --- card output -------------------------------------------------------------

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster", difficulty = 5) {
  const fnd = await talentFindings(name, server, region, className, specName, difficulty);
  if (!fnd) { log("(couldn't read your talents or the field's)"); return; }

  const dpsMiss = fnd.missing.filter((t) => t.dps);
  const utilMiss = fnd.missing.filter((t) => !t.dps);

  log(`=== Talents vs ${fnd.nPeers} top ${specName}s on ${fnd.boss} ===`);
  log(`Your build matches ${fnd.matched}/${fnd.metaTotal} of the talents your peers commonly take.`);
  // Hero tree is one either/or choice -- show the field split, don't list its
  // nodes as individual "missing" talents.
  if (fnd.hero) {
    const fld = fnd.hero.field.map((h) => `${h.name} ${f(h.pct, 0)}%`).join(" / ");
    log(`Hero tree: you run ${fnd.hero.yours || "?"}; field (${fnd.nPeers} peers) ${fld}.`);
  }
  if (dpsMiss.length) {
    log("");
    log(`${throughputWord().toUpperCase()} talents you're MISSING (peers take them here, you don't):`);
    for (const t of dpsMiss.slice(0, 8)) log(`  - ${wowheadSpell(t.spellId, t.name)} — ${f(100 * t.adopt, 0)}% of peers`);
  }
  // Utility/defensive talents are listed only as context -- they aren't DPS, so
  // they never become recommendations.
  if (utilMiss.length) {
    log("");
    log(`Also missing (utility/defensive the field takes here — not ${metricUnit()}): ${utilMiss.slice(0, 6).map((t) => wowheadSpell(t.spellId, t.name)).join(", ")}.`);
  }
  const offDps = fnd.offMeta.filter((t) => t.dps);
  if (offDps.length) {
    log("");
    log(`Off-meta ${throughputWord().toUpperCase()} picks (few peers run these here — worth re-checking):`);
    for (const t of offDps.slice(0, 6)) log(`  - ${wowheadSpell(t.spellId, t.name)} — only ${f(100 * t.adopt, 0)}% of peers`);
  }
  if (!dpsMiss.length && !offDps.length) {
    log("");
    log(`Your ${throughputWord()} talents line up with your peers on this boss — no obvious ${metricUnit()} swaps.`);
  }
}
