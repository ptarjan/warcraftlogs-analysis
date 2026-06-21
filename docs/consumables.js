// @ts-check
// Consumables evidence card: what you ran (flask / food / combat potion / weapon oil /
// augment rune) vs the ilvl-matched field. The Gear card owns enchants/gems/trinkets;
// this card owns the consumables -- the other half of "setup". Detection reuses the ONE
// CONSUMABLES table (shared with the prescription's consumable levers), so the card and
// the lever can never disagree about what counts as a flask. The prescription SIZES the
// gap; this card is the evidence behind it (a card may overlap the prescription, just not
// another card).
import {
  bestKill, playerMetrics, buffUptimes, ilvlPeers, PEER_SAMPLE, collectUpTo,
  head, arrow, topEntry,
} from "./core.js";
import { CONSUMABLES, consumableHit } from "./prescribe-helpers.js";
import { wowheadSpell } from "./links.js";

// What consumable (if any) the player ran in each category, from their aura table.
// Returns { [mine]: { name, guid } | null } keyed by the CONSUMABLES `mine` field.
export function detectMine(auras) {
  const out = {};
  for (const c of CONSUMABLES) {
    const hit = Object.entries(auras || {}).find(([n, b]) => consumableHit(c, n.toLowerCase(), b));
    out[c.mine] = hit ? { name: hit[0], guid: hit[1].guid } : null;
  }
  return out;
}

// Tally the field's consumables per category: name -> count, plus the spell guid for a
// Wowhead link. Pure over the peers' aura tables.
export function tallyField(peerAuras) {
  const tally = {};            // mine -> Map(name -> count)
  const guids = {};            // name -> guid
  for (const c of CONSUMABLES) tally[c.mine] = new Map();
  for (const auras of peerAuras) {
    for (const c of CONSUMABLES) {
      for (const [n, b] of Object.entries(auras || {})) {
        if (!consumableHit(c, n.toLowerCase(), b)) continue;
        tally[c.mine].set(n, (tally[c.mine].get(n) || 0) + 1);
        guids[n] = b.guid;
        break;                 // one per category per peer
      }
    }
  }
  return { tally, guids };
}

export async function run(log, name, server, region, className = "Monk",
  specName = "Brewmaster", difficulty = 5) {
  const best = await bestKill(name, server, region, difficulty);
  if (!best) { log("  (no current-gear kill found)"); return; }
  const you = await playerMetrics(best.code, best.fight, name, specName, className);
  if (!you) { log("  (couldn't read your kill)"); return; }
  const mine = detectMine(await buffUptimes(best.code, best.fight, you.sourceID));

  // The same ilvl-matched field every other card uses (fetches coalesce). Only the buff
  // table is needed here, so this is cheap on top of what the prescription already pulls.
  const cands = await ilvlPeers(name, server, region, best.encounter, difficulty, className, specName);
  const peerAuras = await collectUpTo(cands, PEER_SAMPLE, 5, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (!m) return null;
    return buffUptimes(r.report.code, r.report.fightID, m.sourceID);
  });
  log("");
  log(head(`Consumables on ${best.encounter.name} · vs ${peerAuras.length} ilvl-matched peers`));
  if (!peerAuras.length) { log("  (no ilvl-matched peers to compare against)"); return; }

  const { tally, guids } = tallyField(peerAuras);
  const n = peerAuras.length;
  let missing = 0, mismatched = 0;
  for (const c of CONSUMABLES) {
    const counter = tally[c.mine];
    const top = counter.size ? topEntry(counter) : null;          // [name, count] the field favors
    const fieldStr = top ? `${wowheadSpell(guids[top[0]], top[0])} (${top[1]}/${n} peers)` : "few peers bother";
    const yours = mine[c.mine];
    if (!yours) {
      // Only call it MISSING when the field actually runs one (most do).
      if (top && top[1] >= n / 2) missing++;
      log(`  ${c.label.padEnd(14)} you ran NONE${top && top[1] >= n / 2 ? "" : " (and the field mostly skips it too)"} · field: ${fieldStr}`);
    } else if (top && yours.name !== top[0] && !c.genericBuff) {
      // genericBuff (food): "Hearty Well Fed" vs "Well Fed" are ranks of the same buff,
      // not different foods -- you're fed, so it matches the field (no actionable swap).
      mismatched++;
      log(`  ${c.label.padEnd(14)} you ran ${wowheadSpell(yours.guid, yours.name)} · field: ${fieldStr}`);
    } else {
      log(`  ${c.label.padEnd(14)} you ran ${wowheadSpell(yours.guid, yours.name)} · matches the field`);
    }
  }
  log(arrow(missing
    ? `you're missing ${missing} consumable${missing > 1 ? "s" : ""} the field runs -- free parses (the prescription sizes them).`
    : mismatched
    ? `you run every category, but ${mismatched} differ${mismatched > 1 ? "" : "s"} from the field's pick -- usually minor; the prescription flags any that measure a real gain.`
    : `your consumables match the field -- nothing to change here.`));
}
