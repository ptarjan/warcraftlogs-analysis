// @ts-check
// Healer-specific analysis -- the levers a healer actually CONTROLS, not the
// damage-shaped ones. HPS itself is damage-bound (you can't heal damage that
// didn't happen), so the field-relative HPS gap is mostly the encounter + healer
// comp + assignment (see prescribe's "HEALING IS DAMAGE-BOUND" remainder). What a
// healer DOES control is EFFICIENCY: how much of their output is overheal (wasted)
// and how they spend mana. Cooldown USAGE stays in rotation.js -- "use Rewind on
// cooldown" is a valid HPS rec and isn't reactive. Class-agnostic, always: ability
// names come from YOUR own healing breakdown (the Healing table), never hard-coded.
import {
  ilvlPeers, playerMetrics, bestKill, mapLimit, median, healingBreakdown, manaStats,
  f, DPS, INFO, finding, DIM, KIND, runIsHealer,
} from "./core.js";

// Overheal % above the field by this many points reads as real spill worth a
// callout, not sampling noise. Below it, your efficiency ~matches the field.
const OVERHEAL_NOISE_PTS = 5;

// Your worst-spill abilities: the ones dumping the most ABSOLUTE overheal, among
// abilities that are a real part of your output (>= `minShare` of raw healing) so
// a tiny 100%-overheal proc can't masquerade as your biggest problem. Pure.
// `you` carries overhealBy (spill per ability) + dmgBy (effective per ability).
export function worstSpill(you, { top = 3, minShare = 0.03, minSpillShare = 0.1 } = {}) {
  const ovhBy = (you && you.overhealBy) || {};
  const effBy = (you && you.dmgBy) || {};
  const rawTotal = Object.keys(ovhBy).reduce((s, n) => s + (ovhBy[n] || 0) + (effBy[n] || 0), 0) || 1;
  const spillTotal = Object.values(ovhBy).reduce((s, v) => s + (v || 0), 0) || 1;
  return Object.keys(ovhBy)
    .map((n) => ({ name: n, ovh: ovhBy[n] || 0, raw: (ovhBy[n] || 0) + (effBy[n] || 0) }))
    // Real part of your output (not a tiny proc) AND a real part of your TOTAL
    // spill (so a near-efficient ability that merely ranks high by absolute waste
    // isn't named as a "biggest spill").
    .filter((a) => a.ovh > 0 && a.raw / rawTotal >= minShare && a.ovh / spillTotal >= minSpillShare)
    .sort((a, b) => b.ovh - a.ovh)
    .slice(0, top)
    .map((a) => a.name);
}

// OVERHEALING lever. Your overheal % vs the ilvl-matched field's. Fires only when
// you spill MORE than the field (never punish efficient play). Sized by the
// throughput you'd recover by matching the field's efficiency on the SAME raw
// output: effective rises by (yourPct - fieldPct)/(100 - yourPct). Damped (you
// can't perfectly snipe; HPS is still damage-bound) and capped so no single lever
// claims the whole gap. basis "measured" -- the overheal % is read from your log.
//   you   = your playerMetrics (overhealPct, overhealBy, dmgBy)
//   field = { overhealMed }  (median peer overheal %, or null when no field)
export function overhealLever(you, field) {
  const yourPct = (you && you.overhealPct) || 0;
  const fieldPct = field && field.overhealMed != null ? field.overhealMed : null;
  if (fieldPct == null || yourPct <= fieldPct + OVERHEAL_NOISE_PTS) return [];
  const recoverFrac = (yourPct - fieldPct) / Math.max(1, 100 - yourPct);
  const pct = Math.min(Math.max(1, Math.round(recoverFrac * 100 * 0.5)), 10);
  const worst = worstSpill(you);
  const where = worst.length ? ` Your biggest spill: ${worst.join(", ")}.` : "";
  // DIM.ROTATION + KIND.OVERHEAL: overhealing is a HOW-YOU-HEAL technique fix (which
  // heals you cast, when), NOT a gear/setup item. Tagging it SETUP made the verdict
  // miscount it as one of "the N gear/setup fixes" and headline gear even when cutting
  // overheal was the player's single biggest lever (Lisalisa: 10% #1, all gear smaller).
  return [finding(DIM.ROTATION, DPS(pct),
    `OVERHEALING: ${f(yourPct, 0)}% of your healing is overheal vs the ilvl field's ${f(fieldPct, 0)}% -- ` +
    `that's output landing on already-full targets.${where} Hold big/slow heals for real damage, snipe with cheaper ` +
    `spells, and don't pre-cast into full health bars; the recovered efficiency is mana and effective throughput when it counts.`,
    "measured", KIND.OVERHEAL)];
}

// MANA lever. Fires only when measured mana data is present (you.mana). HPS is
// damage-bound, so the actionable mana signal is HEADROOM: finishing a fight with
// a lot of mana unspent means you could have cast more/bigger heals (or held fewer
// GCDs), while going dry early is the opposite failure. We don't size it as a DPS%
// (no clean field-priced delta) -- it's a measured INFO diagnostic the player acts
// on directly. `you.mana = { endPct, oom (ms into fight or null), wastePct }`.
// `overhealFlagged` = the OVERHEALING lever actually fired (you spill MORE than the
// field). It gates the "(see OVERHEALING)" pointer: the old code keyed the "spilling"
// message off an ABSOLUTE 20% overheal, but the OVERHEALING lever fires on a RELATIVE
// field+5pp threshold -- so a healer at a field-NORMAL 22% overheal (Teejvoker) got
// told to "heal smarter (see OVERHEALING)" with no OVERHEALING item in the list.
export function manaLever(you, overhealFlagged = false) {
  const m = you && you.mana;
  if (!m || m.endPct == null) return [];
  // Ran genuinely DRY: hit ~empty AND finished low (a momentary dip that recovers
  // isn't a problem). The back half then heals on regen alone.
  if (m.oom != null && m.endPct <= 20) {
    return [finding(DIM.SETUP, INFO,
      `MANA: you ran your mana to empty ~${f(m.oom / 1000, 0)}s in and finished at ${f(m.endPct, 0)}% -- the rest is healed on regen alone. ` +
      `Smooth your spend (cheaper fillers between damage events, fewer overheals) so you aren't dry when a spike or your cooldowns land.`,
      "measured")];
  }
  // Lots LEFT: finished with mana to spare. What that MEANS depends on overheal:
  if (m.endPct >= 30) {
    const oh = you.overhealPct || 0;
    // (1) The OVERHEALING lever FIRED -> "heal more" would just overheal; point at it.
    if (overhealFlagged) {
      return [finding(DIM.SETUP, INFO,
        `MANA: you finished with ~${f(m.endPct, 0)}% mana unspent -- mana wasn't your limiter (your HPS is bounded by the damage taken + overhealing, not mana). The lever isn't "cast more" (you already overheal ${f(oh, 0)}%); it's healing SMARTER -- spend that spare mana on heals that LAND (see OVERHEALING), not more casts into full bars.`,
        "measured")];
    }
    // (2) Genuinely EFFICIENT (low overheal) -> you had headroom to be more aggressive.
    if (oh < 20) {
      return [finding(DIM.SETUP, INFO,
        `MANA: you finished with ~${f(m.endPct, 0)}% mana unspent (low-water ${f(m.minPct, 0)}%) and you're efficient (only ${f(oh, 0)}% overheal) -- you had headroom to be more aggressive (bigger/earlier casts, cover more of the damage) rather than bank mana. That spare mana is effective healing left on the table.`,
        "measured")];
    }
    // (3) Overheal high in ABSOLUTE terms but NOT flagged above the field (or no field) --
    // mana isn't the limiter AND your efficiency isn't an outlier, so neither is a lever;
    // the rest is damage-bound. Don't dangle a "(see OVERHEALING)" that isn't in the list.
    return [finding(DIM.SETUP, INFO,
      `MANA: you finished with ~${f(m.endPct, 0)}% mana unspent -- mana wasn't your limiter (your HPS is bounded by the damage taken, not mana). Your ${f(oh, 0)}% overheal isn't flagged above the field, so cutting it isn't a separate lever here; the rest of the gap is damage-bound (encounter + comp + assignment). Spend mana when there's real damage to catch, not into full bars.`,
      "measured")];
  }
  return [];
}

// All healer-specific levers, folded into the prescription by prescribe.run.
// Silent for non-healers (a DPS run has overheal 0 and no mana data anyway).
export function healingLevers(you, field) {
  if (!runIsHealer() || !you) return [];
  const overheal = overhealLever(you, field);                 // fires only ABOVE the field
  return [...overheal, ...manaLever(you, overheal.length > 0)]; // mana cites OVERHEALING only if it fired
}

// --- supporting card ---------------------------------------------------------
// The "Healing efficiency" evidence behind the OVERHEALING/MANA levers above.
// Only meaningful for healers; app.js shows this card only on an HPS run.
export async function run(log, name, server, region, className, specName, difficulty = 5) {
  if (!runIsHealer()) { log("(Healing efficiency is computed only for healer specs.)"); return; }
  const best = await bestKill(name, server, region, difficulty);
  if (!best) { log("[error] no kill found to read your healing from."); return; }
  const you = await playerMetrics(best.code, best.fight, name, specName, className);
  if (!you) { log("[error] could not read your healing breakdown."); return; }
  // Per-ability overheal (sourceID-filtered Healing table -- reuses rotation's fetch)
  // and mana over the fight. Both best-effort.
  try { const hb = await healingBreakdown(best.code, best.fight, you.sourceID); you.overhealBy = hb.overhealBy; you.dmgBy = hb.effBy; } catch (e) { /* keep entry-level only */ }
  try { you.mana = await manaStats(best.code, best.fight, you.sourceID); } catch (e) { /* no mana data */ }

  // Field overheal % from the SAME ilvl-matched peer set every other section uses
  // (core.ilvlPeers -> the fetches dedupe; no divergent selection). Best-effort.
  let field = { overhealMed: null, n: 0 };
  try {
    const cands = await ilvlPeers(name, server, region, best.encounter, difficulty, className, specName);
    const pcts = (await mapLimit(cands, 5, async (r) => {
      const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
      return m ? m.overhealPct : null;
    })).filter((x) => x != null);
    if (pcts.length) field = { overhealMed: median(pcts), n: pcts.length };
  } catch (e) { /* no field -> show your numbers alone */ }

  log(`Healing efficiency on ${best.encounter.name} (your most recent kill at current gear).`);
  log("");
  log("=== OVERHEALING (wasted output) ===");
  const fieldStr = field.overhealMed != null ? `${f(field.overhealMed, 0)}% (n=${field.n})` : "n/a (no ilvl field)";
  log(`  overheal %:  you ${f(you.overhealPct, 0)}%   field ${fieldStr}`);
  if (field.overhealMed != null) {
    log(you.overhealPct > field.overhealMed + OVERHEAL_NOISE_PTS
      ? "  -> You spill more than the field -- see the OVERHEALING item in the list."
      : "  -> About the field's rate. Your efficiency isn't the lever; HPS is damage-bound (comp + assignment).");
  }
  const worst = worstSpill(you);
  if (worst.length) {
    log("");
    log("  Most overheal by ability (absolute spill):");
    const ovhBy = you.overhealBy || {}, effBy = you.dmgBy || {};
    for (const n of worst) {
      const ovh = ovhBy[n] || 0, raw = ovh + (effBy[n] || 0);
      log(`    ${String(n).padEnd(22)} ${f(100 * ovh / (raw || 1), 0).padStart(3)}% overheal  (${Math.round(ovh).toLocaleString()} spilled)`);
    }
  }
  if (you.mana) {
    log("");
    log("=== MANA ===");
    log(`  end-of-fight: ${f(you.mana.endPct, 0)}%   low-water: ${f(you.mana.minPct, 0)}%` +
        (you.mana.oom != null ? `   first ~empty at ${f(you.mana.oom / 1000, 0)}s` : ""));
    log(you.mana.endPct >= 30
      ? "  -> Mana to spare -- on a damage-bound kill that's effective healing left on the table (heal more)."
      : you.mana.oom != null && you.mana.endPct <= 20
      ? "  -> You ran dry -- smooth your spend so you're not empty when the damage comes."
      : "  -> Spent about right.");
  }
  log("");
  log("=== HEALING COOLDOWNS ===");
  log("  Under-used healing cooldowns are sized in the ROTATION section (the COOLDOWN items) --");
  log("  for a healer those are real HPS recs (e.g. using a healing CD on cooldown).");
}
