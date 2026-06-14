// @ts-check
// Support-spec analysis (Augmentation Evoker). A support's throughput is mostly
// the buffs/amps it maintains on ALLIES (Ebon Might / Prescience), which WCL
// credits to those allies' parses, NOT to the support's own DPS -- so "X% behind
// on personal DPS" mis-measures them the way HPS mis-measures a healer (see
// prescribe's SUPPORT remainder + the reframed gap line). This card surfaces what
// we CAN measure: the amps you carried this kill. Class-agnostic -- buff names come
// from your own aura list, never a hard-coded ability list.
//
// LIMITATION (honest, by design): the Buffs table filtered by your sourceID returns
// the auras ON YOU (your Ebon Might/Prescience self-uptime, plus every raid buff and
// HoT others put on you), NOT the buffs you applied to ALLIES. Measuring ally
// COVERAGE precisely -- the real support lever -- needs per-target buff-EVENT data
// (applybuff/removebuff by you, on each ally), which we don't yet pull. So this card
// is descriptive (your maintained amps), not a field-relative lever: a naive
// field comparison off this table flags raid buffs your raid happened to lack
// (Power Word: Fortitude, Vantus Rune) as "your" missing amps -- a false positive we
// deliberately don't ship. The ally-coverage lever is a verified follow-up.
import {
  bestKill, playerMetrics, buffUptimes,
  f, runIsSupport,
} from "./core.js";

// Amps worth showing as YOURS: maintained at a real uptime (>= floor) but not the
// ~always-on universal raid buffs/consumables (~100%) that every actor carries and
// that say nothing about your play. A coarse, honest descriptive band -- NOT a lever.
const SHOW_MIN = 20;    // % uptime to be worth listing as a maintained amp
const SHOW_MAX = 99;    // above this is a permanent raid buff/consumable, not your amp

// --- supporting card ---------------------------------------------------------
// The "Support buffs" context behind the SUPPORT remainder in the prescription.
// Only meaningful for support specs; app.js shows it only on a support run.
export async function run(log, name, server, region, className, specName, difficulty = 5) {
  if (!runIsSupport()) { log("(Support-buff analysis is computed only for support specs.)"); return; }
  const best = await bestKill(name, server, region, difficulty);
  if (!best) { log("[error] no kill found to read your buffs from."); return; }
  const you = await playerMetrics(best.code, best.fight, name, specName, className);
  if (!you) { log("[error] could not read your buff uptimes."); return; }
  let myBuffs = {};
  try { myBuffs = await buffUptimes(best.code, best.fight, you.sourceID); } catch (e) { /* none */ }

  log(`Support buffs on ${best.encounter.name} (your most recent kill at current gear).`);
  log("As a support, most of your value is the amps you keep on ALLIES (Ebon Might / Prescience /");
  log("Breath of Eons). WCL credits that to THEIR parses, so your personal DPS understates you --");
  log("that's why the prescription's biggest 'gap' is buff value off your sheet, not DPS to add.");
  log("");
  // buffUptimes values are { pct, guid } objects -- compare on .pct.
  const rows = Object.entries(myBuffs)
    .map(([n, v]) => [n, (v && v.pct) || 0])
    .filter(([, p]) => p >= SHOW_MIN && p <= SHOW_MAX)
    .sort((a, b) => b[1] - a[1]);
  if (rows.length) {
    log("=== AMPS / AURAS YOU MAINTAINED (uptime on YOU this kill) ===");
    for (const [n, p] of rows) log(`  ${String(n).padEnd(28)} ${f(p, 0).padStart(4)}%`);
    log("");
    log("  NOTE: this is buffs ON you (your own amps' self-uptime, plus HoTs/raid buffs others");
    log("  gave you). Your ALLY coverage -- the real lever -- needs per-target buff data we don't");
    log("  pull yet, so we don't size a buff-uptime lever here (a naive one flags raid buffs your");
    log("  raid lacked as 'yours'). Keep your amps rolling on the right targets; chase that on a");
    log("  fixed kill, not the raw personal-DPS number. Your concrete personal levers (Breath of");
    log("  Eons / cooldowns / gear) are in the PRESCRIPTION.");
  } else {
    log("(No maintained amps read from this kill -- the Buffs table may be unavailable.)");
  }
}
