// Automatic gear audit: reads each item's real secondary stats (via the Worker's
// Wowhead proxy) and compares slot-by-slot to the field. Ported from gear.py.
import { itemTooltip, itemXml, zoneTooltip, npcTooltip } from "./wcl.js";
import {
  playerMetrics, collectPeers, f, mapLimit, topEntry, bestKill,
} from "./core.js";
import { wowheadItem } from "./links.js";

// Collect up to n unique (by name+server) top-ranked candidates across the
// given encounters, so the heavy per-peer fetches can run concurrently.
async function fieldCandidates(className, specName, difficulty, encounters, n) {
  return collectPeers({ encounters, difficulty, className, specName, limit: n, pages: 2 });
}

const SLOT = {
  0: "Head", 1: "Neck", 2: "Shoulder", 4: "Chest", 5: "Belt", 6: "Legs",
  7: "Feet", 8: "Wrist", 9: "Hands", 10: "Ring1", 11: "Ring2",
  12: "Trinket1", 13: "Trinket2", 14: "Back", 15: "Weapon",
};
// Tier-set token slots: you only need 4 of these 5 for the 4pc, so one is a
// "flex" slot. Swapping a tier-eligible slot interacts with the set bonus.
const TIER_SLOTS = new Set([0, 2, 4, 6, 9]); // Head, Shoulder, Chest, Legs, Hands
export const SHORT = {
  "Critical Strike": "crit", "Haste": "haste", "Mastery": "mastery", "Versatility": "vers",
};

// localStorage-backed cache of parsed item stats, keyed by id[:bonus:ids].
// "item2:" bumps the cache namespace (v1 entries predate the source/crafted
// fields); old keys are simply ignored and re-fetched.
function cacheGet(key) {
  try { const v = localStorage.getItem("item2:" + key); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function cacheSet(key, val) {
  try { localStorage.setItem("item2:" + key, JSON.stringify(val)); } catch (e) {}
}

export async function itemStats(itemId, bonusIds) {
  const bonus = (bonusIds || []).map(String);
  const key = String(itemId) + (bonus.length ? ":" + bonus.join(":") : "");
  const cached = cacheGet(key);
  if (cached) return cached;
  let out;
  try {
    const d = await itemTooltip(itemId, bonus);
    const html = d.tooltip || "";
    out = { name: d.name || String(itemId), crit: 0, haste: 0, mastery: 0, vers: 0 };
    const m = html.match(/<!--ilvl-->(\d+)/);
    out.ilvl = m ? parseInt(m[1], 10) : null;
    const re = /(\d+)\s+(Critical Strike|Haste|Mastery|Versatility)/g;
    let mm;
    while ((mm = re.exec(html))) out[SHORT[mm[2]]] += parseInt(mm[1], 10);
    out.embellished = html.includes("Embellished");
    out.unique = html.includes("Unique-Equipped");
    // Where it comes from, straight from the tooltip Wowhead already gives us:
    // the boss that drops it (+ drop chance). Embellished gear is always crafted
    // (no drop), so flag that instead. We deliberately don't map boss -> instance
    // name: that needs a hardcoded, per-tier table (against this repo's rules).
    const dm = html.match(/whtt-droppedby">Dropped by:\s*([^<]+)</i);
    out.source = dm ? dm[1].trim() : null;
    const dc = html.match(/whtt-dropchance">Drop Chance:\s*([^<]+)</i);
    out.dropChance = dc ? dc[1].trim() : null;
    out.crafted = out.embellished && !out.source;
  } catch (e) {
    out = { name: String(itemId), crit: 0, haste: 0, mastery: 0, vers: 0, ilvl: null,
            embellished: false, unique: false, source: null, dropChance: null, crafted: false };
  }
  cacheSet(key, out);
  return out;
}

// Human "where to get it" suffix shared by the audit and the prescription.
// Leads with the instance ("dropped in Windrunner Spire") -- that's the place you
// actually go; the boss is only a fallback when the instance can't be resolved.
export function sourceText(boss, instance, chance) {
  const c = chance ? ` (${chance})` : "";
  if (instance) return ` -- dropped in ${instance}${c}`;
  if (boss) return ` -- dropped by ${boss}${c}`;
  return "";
}

// The instance an item drops in, resolved entirely from Wowhead -- NO hardcoded
// boss->dungeon table, so it works for any item/tier. The item XML's <json> has
// `sourcemore` (the drop sources). Two ways in: the source may carry the instance
// zone id directly (`z`), or just the boss NPC id (`ti`) -- in which case the
// NPC's tooltip gives its `map.zone`. Either way the zone tooltip names it.
// Cached per item id. bossName (from "Dropped by") disambiguates multi-source items.
export async function itemInstance(itemId, bossName) {
  const ck = "inst2:" + String(itemId);
  const cached = cacheGet(ck);
  if (cached) return cached.instance || null;
  let instance = null;
  try {
    const xml = await itemXml(itemId);
    const m = xml.match(/<json><!\[CDATA\[([\s\S]*?)\]\]><\/json>/);
    if (m) {
      const sm = (JSON.parse("{" + m[1] + "}").sourcemore || []).filter((e) => e && (e.z || e.ti));
      const norm = (s) => String(s || "").toLowerCase().trim();
      // Prefer the source naming the dropping boss; else the first zoned/NPC one.
      const pick = (bossName && sm.find((e) => e.n && norm(e.n) === norm(bossName))) || sm[0];
      if (pick) {
        let zoneId = pick.z;
        if (!zoneId && pick.ti) {                       // no zone on the item -> ask the boss NPC
          const npc = await npcTooltip(pick.ti);
          zoneId = npc && npc.map && npc.map.zone;
        }
        if (zoneId) { const zt = await zoneTooltip(zoneId); instance = (zt && zt.name) ? zt.name : null; }
      }
    }
  } catch (e) { instance = null; }
  cacheSet(ck, { instance });
  return instance;
}

// What embellishment SLOT-combos and ITEMS top performers run (empirical).
// Needs per-piece bonus IDs to detect embellishments, so it's a separate,
// smaller sample than fieldConsensus to keep tooltip reads bounded.
async function fieldEmbellishments(className, specName, difficulty, encounters, n = 18) {
  const cands = await fieldCandidates(className, specName, difficulty, encounters, n);
  const perPeer = await mapLimit(cands, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (!m) return null;
    const emb = [];
    for (const g of m.gear) {
      if (g.slot in SLOT) {
        const s = await itemStats(g.id, g.bonusIDs);
        if (s.embellished) emb.push([SLOT[g.slot], s.name]);
      }
    }
    return emb;
  });
  const combos = new Map();      // JSON(sorted slot names) -> count
  const items = new Map();       // item name -> count
  const perSlotItems = new Map();// slot name -> Map(item name -> count)
  let got = 0;
  for (const emb of perPeer) {
    if (!emb || !emb.length) continue;
    got++;
    const comboKey = JSON.stringify(emb.map(([sl]) => sl).sort());
    combos.set(comboKey, (combos.get(comboKey) || 0) + 1);
    for (const [sl, nm] of emb) {
      items.set(nm, (items.get(nm) || 0) + 1);
      const byItem = perSlotItems.get(sl) || new Map();
      byItem.set(nm, (byItem.get(nm) || 0) + 1);
      perSlotItems.set(sl, byItem);
    }
  }
  return { combos, items, perSlotItems, n: got };
}

// Gear from your highest-ilvl kill (= current).
async function yourGear(name, server, region, difficulty, className) {
  const best = await bestKill(name, server, region, difficulty);
  if (!best) return null;
  const m = await playerMetrics(best.code, best.fight, name, null, className);
  if (m) m.encIds = best.killedIds; // killed bosses, for field sampling
  return m;
}

// What top-DPS players wear: per-slot item counts, representative bonus IDs,
// all stat variants seen, gem usage, and each player's gem-color variety.
async function fieldConsensus(className, specName, difficulty, encounters, n = 40) {
  const perSlot = {};          // slot -> Map(itemId -> count)
  const bonusSample = {};      // itemId -> bonusIDs (first seen)
  const variants = {};         // itemId -> Map(bonusKey -> count)
  const gems = new Map();      // gemId -> count
  const gemVariety = [];       // per player: distinct gem ids
  const cands = await fieldCandidates(className, specName, difficulty, encounters, n);
  const metrics = (await mapLimit(cands, 5, (r) =>
    playerMetrics(r.report.code, r.report.fightID, r.name, specName, className))).filter(Boolean);
  for (const m of metrics) {
    const pgems = [];
    for (const g of m.gear) {
      if (g.slot in SLOT && g.name) {
        (perSlot[g.slot] = perSlot[g.slot] || new Map()).set(g.id, (perSlot[g.slot].get(g.id) || 0) + 1);
        if (!(g.id in bonusSample)) bonusSample[g.id] = g.bonusIDs;
        const bk = JSON.stringify(g.bonusIDs || []);
        (variants[g.id] = variants[g.id] || new Map()).set(bk, (variants[g.id].get(bk) || 0) + 1);
      }
      for (const gm of (g.gems || [])) {
        if (gm.id) { gems.set(gm.id, (gems.get(gm.id) || 0) + 1); pgems.push(gm.id); }
      }
    }
    if (pgems.length) gemVariety.push(new Set(pgems).size);
  }
  return { perSlot, bonusSample, variants, gems, gemVariety, n: metrics.length };
}

const topItem = (counter) => { const e = topEntry(counter); return e ? e[0] : null; };

export async function gearFindings(name, server, region, difficulty, className, specName, priority) {
  const you = await yourGear(name, server, region, difficulty, className);
  if (!you) return null;
  const ymap = {};
  for (const g of you.gear) ymap[g.slot] = g;
  const enc = (you.encIds && you.encIds.length) ? you.encIds : []; // killed bosses (tier-agnostic)
  const fc = await fieldConsensus(className, specName, difficulty, enc);
  const { perSlot, bonusSample, variants } = fc;
  const myItemIds = new Set(you.gear.map((g) => g.id));
  const rows = [], swaps = [], embellishedSlots = [], restats = [], yourEmbItems = [];
  for (const s of Object.keys(SLOT).map(Number).sort((a, b) => a - b)) {
    if (!(s in ymap)) continue;
    const g = ymap[s];
    const ist = await itemStats(g.id, g.bonusIDs);
    const topId = topItem(perSlot[s]);
    let match;
    if (topId === g.id) match = "== peers";
    else if (topId) match = `peers: ${(await itemStats(topId, bonusSample[topId])).name.slice(0, 22)}`;
    else match = "?";
    rows.push([SLOT[s], ist, match, ist.embellished]);
    if (ist.embellished) { embellishedSlots.push(SLOT[s]); yourEmbItems.push(ist.name); }

    let best = ist[priority] || 0;
    for (const bk of (variants[g.id] || new Map()).keys()) {
      const v = (await itemStats(g.id, JSON.parse(bk)))[priority] || 0;
      if (v > best) best = v;
    }
    if (best > (ist[priority] || 0) + 15) {
      restats.push({ slot: SLOT[s], itemName: ist.name, itemId: g.id, current: ist[priority] || 0, achievable: best });
    }

    // Drop swap: scan EVERY item the field runs in this slot for one with
    // meaningfully more of the priority stat. ONLY where a swap costs nothing
    // structural: not a trinket (effect-based), not one of YOUR embellished
    // slots, and not a tier-eligible slot (set-bonus interaction).
    const structural = (s === 12 || s === 13) || ist.embellished || TIER_SLOTS.has(s);
    const yoursPri = ist[priority] || 0;
    const slotCounter = perSlot[s] || new Map();
    const slotTotal = [...slotCounter.values()].reduce((a, b) => a + b, 0) || 1;
    let bestAlt = null;
    if (!structural) {
      for (const [candId, cnt] of slotCounter) {
        if (candId === g.id) continue;
        const cst = await itemStats(candId, bonusSample[candId]);
        if (cst.unique && myItemIds.has(candId)) continue;
        // require real adoption (>=3 of the field) to skip off-meta noise
        if ((cst[priority] || 0) - yoursPri >= 30 && cnt >= 3) {
          if (!bestAlt || cst[priority] > bestAlt.gain) {
            bestAlt = { name: cst.name, gain: cst[priority], count: cnt, source: cst.source, dropChance: cst.dropChance, id: candId };
          }
        }
      }
    }
    if (bestAlt) {
      const instance = await itemInstance(bestAlt.id, bestAlt.source); // resolve dungeon/raid name
      swaps.push({
        slot: SLOT[s], fromName: ist.name, fromId: g.id,         // your current item
        toName: bestAlt.name, toId: bestAlt.id,                  // the field's item to swap to
        gain: bestAlt.gain, count: bestAlt.count, total: slotTotal,
        source: bestAlt.source, dropChance: bestAlt.dropChance, instance,
      });
    }
  }

  // Embellishment combo vs the field -- empirical: how does YOUR pair of
  // embellishments rank among what top performers actually run?
  const fe = await fieldEmbellishments(className, specName, difficulty, enc);
  const yourCombo = embellishedSlots.slice().sort();
  const comboList = [...fe.combos.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, cnt]) => [JSON.parse(k), cnt]);
  const yourComboKey = JSON.stringify(yourCombo);
  let yourRank = null;
  for (let i = 0; i < comboList.length; i++) {
    if (JSON.stringify(comboList[i][0]) === yourComboKey) { yourRank = [i + 1, comboList[i][1]]; break; }
  }
  const yourItemsPop = yourEmbItems.map((nm) => [nm, fe.items.get(nm) || 0]);
  const topItems = [...fe.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  // The concrete recommendation: for the #1 slot-combo the field runs, name the
  // single most popular embellishment ITEM in each of those slots -- so the
  // advice is "craft <item> on your <slot>", not just "pick some combo".
  const topItemInSlot = (sl) => topEntry(fe.perSlotItems.get(sl)); // [name, count] | null
  const recommended = (comboList[0] ? comboList[0][0] : [])
    .map((sl) => { const it = topItemInSlot(sl); return it ? [sl, it[0], it[1]] : null; })
    .filter(Boolean); // [[slot, itemName, count], ...]
  const embCompare = {
    yourCombo: yourCombo, yourRank: yourRank, topCombos: comboList.slice(0, 4),
    fieldN: fe.n, yourItemsPop: yourItemsPop, topItems: topItems, recommended,
  };

  // Holistic per-slot reconciliation: a slot earmarked for an embellishment
  // (your current ones, or the combo we recommend) gets ONE plan -- the
  // embellishment -- not also a "swap to a drop here" line for the same slot.
  // (A crafted embellished piece is itemized to your stat anyway.)
  const embPlanSlots = new Set([...yourCombo, ...recommended.map((r) => r[0])]);
  const reconciledSwaps = swaps.filter((sw) => !embPlanSlots.has(sw.slot));

  const myGems = you.gear.flatMap((g) => (g.gems || []).map((gm) => gm.id)).filter(Boolean);
  const gemCount = new Map();
  for (const id of myGems) gemCount.set(id, (gemCount.get(id) || 0) + 1);
  const fieldTop = [...fc.gems.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const variety = fc.gemVariety.slice().sort((a, b) => a - b);
  const gemInfo = {
    yourGems: gemCount, yourVariety: new Set(myGems).size,
    fieldTop: fieldTop,
    fieldVarietyMed: variety.length ? variety[Math.floor(variety.length / 2)] : null,
  };
  return { rows, swaps: reconciledSwaps, embellishedSlots, restats, embCompare: embCompare, n: fc.n, priority, gems: gemInfo };
}

export async function run(log, name, server, region, difficulty, className, specName, priority) {
  const ff = await gearFindings(name, server, region, difficulty, className, specName, priority);
  if (!ff) throw new Error("No gear found.");
  log("");
  log(`=== Gear audit for ${name} (priority: ${priority}) | vs ${ff.n} top-DPS ${specName}s ===`);
  log(`${"SLOT".padEnd(9)} ${"YOUR ITEM".padEnd(30)} ${"crit/hst/mas/ver".padEnd(17)} matches peers?`);
  for (const [slot, ist, match, embellished] of ff.rows) {
    const secs = `${String(ist.crit).padStart(3)}/${String(ist.haste).padStart(3)}/${String(ist.mastery).padStart(3)}/${String(ist.vers).padStart(3)}`;
    log(`${slot.padEnd(9)} ${ist.name.slice(0, 30).padEnd(30)} ${secs.padEnd(17)} ${match}${embellished ? " [EMBELLISHED]" : ""}`);
  }
  log("");
  log(`Legend: crit/haste/mastery/vers. [EMBELLISHED] = crafted slot carrying an embellishment (you can re-stat it to ${priority}).`);

  const emb = ff.embellishedSlots;
  log("");
  log(`Embellishments: ${emb.length ? emb.join(", ") : "none detected"} (${emb.length}/2 used).`);
  if (emb.length < 2) log("  -> You have a free embellishment slot -- a big throughput gain you're not using.");

  const ec = ff.embCompare;
  if (ec) {
    const rank = ec.yourRank ? `#${ec.yourRank[0]} most common (${ec.yourRank[1]}/${ec.fieldN})` : "NOT seen in the field";
    log("");
    log(`Embellishment combo vs peers: yours = ${ec.yourCombo.join(" + ") || "none"} -> ${rank}.`);
    log(`  top peer combos: ${ec.topCombos.map(([c, n]) => `${c.join("+")} (${n})`).join(", ")}`);
    log(`  your embellishment items' popularity among peers: ${ec.yourItemsPop.map(([nm, pop]) => `${nm} (${pop})`).join(", ")}`);
    if (ec.recommended && ec.recommended.length)
      log(`  -> craft the #1 combo's items: ${ec.recommended.map(([sl, nm, cnt]) => `${nm} on ${sl} (${cnt}/${ec.fieldN})`).join(", ")}`);
    else if (!ec.yourRank) log("  -> Consider matching a top combo above (yours isn't one top performers run).");
  }

  const gi = ff.gems;
  const totalGems = [...gi.yourGems.values()].reduce((s, v) => s + v, 0);
  log("");
  log(`Gems: you run ${totalGems} gem(s), ${gi.yourVariety} distinct color(s); peer median ${gi.fieldVarietyMed} distinct.`);
  log(`  peers' most-used gems (id x count): ${JSON.stringify(gi.fieldTop)}`);
  log(`  your gems (id x count): ${JSON.stringify(Object.fromEntries(gi.yourGems))}`);

  if (ff.swaps.length) {
    log("");
    log(`${priority[0].toUpperCase() + priority.slice(1)} drop CANDIDATES (a crit-itemized item peers run in a non-tier/non-embellished slot of yours -- sim to confirm net gain):`);
    for (const sw of ff.swaps) {
      log(`  ${sw.slot}: ${wowheadItem(sw.fromId, sw.fromName)} -> ${wowheadItem(sw.toId, sw.toName)} (+${sw.gain} ${priority}; ${sw.count}/${sw.total} of peers)${sourceText(sw.source, sw.instance, sw.dropChance)}`);
    }
  } else {
    log("");
    log(`No ${priority} drop-swap available -- no item peers run in any slot beats your ${priority} by enough to matter.`);
  }
  if (ff.restats.length) {
    log("");
    log(`Re-stat opportunities (others run MORE ${priority} on your SAME item, so the stats are selectable):`);
    for (const rs of ff.restats) log(`  ${rs.slot} ${wowheadItem(rs.itemId, rs.itemName)}: you ${rs.current} ${priority} -> achievable ${rs.achievable}`);
  } else {
    log("");
    log(`No re-stat gains: on every item you own, no peer runs more ${priority} than you -- your stats are maxed/fixed for the gear you have.`);
  }
}
