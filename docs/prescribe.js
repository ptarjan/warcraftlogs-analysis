// @ts-check
// Generate a concrete, prioritized prescription. Ported from prescribe.py.
// prescribe folds every analysis's findings (the shared { dim, impact, label,
// text } currency from core) into ONE sorted change-list. Each domain owns its
// own lever-construction (gearLevers/rotationLevers/topParseLevers); prescribe
// adds the cross-cutting ones (execution, consumables, enchants, stat gap) that
// need its own peer aggregates, then sorts + splits + renders.
import {
  ENCHANTABLE_SLOTS, DIFFICULTY, characterZone, characterEncounter, playerMetrics,
  collectPeers, secondaryStats, buffUptimes, median, f, detectPriority, mapLimit, topEntry, bestRank,
  DPS, INFO, finding, isHealer,
} from "./core.js";
import { timelineFindings } from "./timeline.js";
import { gearFindings, gearLevers } from "./gear.js";
import { wowheadSpell } from "./links.js";
import { rotationFindings, rotationLevers } from "./rotation.js";
import { talentFindings, talentLevers } from "./talents.js";
import { topParseFindings, topParseLevers } from "./topparse.js";

const SLOT_NAME = ENCHANTABLE_SLOTS;

// A short headline for a finding (its keyword + first action clause), for naming
// the #1 lever in the synthesis without dumping the whole sentence.
export function rxHeadline(text) {
  const head = String(text).split(/ -- |;|\(/)[0].trim();
  return head.length > 72 ? head.slice(0, 69) + "…" : head;
}

async function bestIlvlKill(name, server, region, encounterId, difficulty) {
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  const best = bestRank(er && er.ranks);
  if (!best) return null;
  return [best.report.code, best.report.fightID, best.bracketData];
}

async function fieldGearConsumables(encounterId, difficulty, className, specName, targetIlvl, priority = "crit", n = 10) {
  const enchBySlot = {};   // slot -> Map(name -> count)
  const trinkets = new Map(), flasks = new Map(), foods = new Map(), potions = new Map(), augRunes = new Map(), oils = new Map();
  const guids = new Map(); // flask/food name -> spell guid (for Wowhead links)
  const statPcts = [];
  // Collect ilvl-matched candidates, then fetch each peer's gear/buffs/stats
  // concurrently (bounded) instead of one slow peer at a time.
  const cands = await collectPeers({ encounters: encounterId, difficulty, className, specName,
    limit: n + 3, pages: 7, ilvl: targetIlvl, window: 2 });
  const peers = (await mapLimit(cands, 5, async (r) => {
    const code = r.report.code, fight = r.report.fightID;
    const m = await playerMetrics(code, fight, r.name, specName, className);
    if (!m) return null;
    const bf = await buffUptimes(code, fight, m.sourceID);
    const s = await secondaryStats(code, fight, m.sourceID, className);
    return { m, bf, s };
  })).filter(Boolean).slice(0, n);

  for (const { m, bf, s } of peers) {
    for (const g of m.gear) {
      const slot = g.slot;
      if (slot in SLOT_NAME && g.permanentEnchantName) {
        const slotName = SLOT_NAME[slot];
        (enchBySlot[slotName] = enchBySlot[slotName] || new Map())
          .set(g.permanentEnchantName, (enchBySlot[slotName].get(g.permanentEnchantName) || 0) + 1);
      }
      if ((slot === 12 || slot === 13) && g.name) trinkets.set(g.name, (trinkets.get(g.name) || 0) + 1);
    }
    for (const [nm, b] of Object.entries(bf)) {
      const lc = nm.toLowerCase();
      if (b.pct > 50 && lc.includes("flask")) { flasks.set(nm, (flasks.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      if (b.pct > 50 && lc.includes("well fed")) { foods.set(nm, (foods.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      // Combat potions are brief (a few uses), so any uptime counts; exclude heals.
      if (b.pct > 0 && lc.includes("potion") && !lc.includes("healing")) { potions.set(nm, (potions.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      // Augment rune: a persistent +primary-stat consumable (a free flat gain).
      if (b.pct > 50 && lc.includes("augment rune")) { augRunes.set(nm, (augRunes.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      // Weapon oil / sharpening stone: a TEMPORARY weapon buff you re-apply, like
      // a flask -- NOT the permanent weapon enchant (that's the ENCHANTS check).
      if (b.pct > 50 && /\boil\b|sharpening|whetstone|weightstone/.test(lc)) { oils.set(nm, (oils.get(nm) || 0) + 1); guids.set(nm, b.guid); }
    }
    if (s) {
      const sec = ["crit", "haste", "mastery", "vers"].reduce((acc, k) => acc + s[k], 0) || 1;
      statPcts.push(100 * s[priority] / sec);
    }
  }
  return {
    enchBySlot, trinkets, flasks, foods, potions, augRunes, oils, guids,
    statPct: statPcts.length ? median(statPcts) : null, n: peers.length,
    dpsMed: peers.length ? median(peers.map((p) => p.m.dps)) : null, // measured field DPS
  };
}

async function mySetup(code, fight, sourceId, gear, priority = "crit", className = "Monk") {
  const bf = await buffUptimes(code, fight, sourceId);
  const flask = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("flask") && b.pct > 50);
  const food = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("well fed") && b.pct > 50);
  const potion = Object.entries(bf).find(([n, b]) => {
    const lc = n.toLowerCase();
    return lc.includes("potion") && !lc.includes("healing") && b.pct > 0;
  });
  const augrune = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("augment rune") && b.pct > 50);
  const oil = Object.entries(bf).find(([n, b]) => /\boil\b|sharpening|whetstone|weightstone/.test(n.toLowerCase()) && b.pct > 50);
  const stats = await secondaryStats(code, fight, sourceId, className);
  const statPct = stats
    ? 100 * stats[priority] / (["crit", "haste", "mastery", "vers"].reduce((a, k) => a + stats[k], 0) || 1)
    : null;
  const trinkets = gear.filter((g) => g.slot === 12 || g.slot === 13).map((g) => g.name);
  const ench = new Set(gear.filter((g) => g.slot in SLOT_NAME && g.permanentEnchant).map((g) => SLOT_NAME[g.slot]));
  return {
    flask: flask ? flask[0] : null, flaskGuid: flask ? flask[1].guid : null,
    food: food ? food[0] : null, foodGuid: food ? food[1].guid : null,
    potion: potion ? potion[0] : null, potionGuid: potion ? potion[1].guid : null,
    augrune: augrune ? augrune[0] : null, augruneGuid: augrune ? augrune[1].guid : null,
    oil: oil ? oil[0] : null, oilGuid: oil ? oil[1].guid : null,
    statPct, trinkets, ench,
  };
}

async function aggregateExecution(name, server, region, difficulty, className, specName, bosses) {
  const perBoss = [];
  for (const r of bosses) {
    let c;
    try { c = await timelineFindings(name, server, region, r.encounter, difficulty, className, specName); }
    catch (e) { c = null; }
    if (c) perBoss.push(c);
  }
  if (!perBoss.length) return null;
  const med = (key) => median(perBoss.map((c) => c.you[key] - c.peer[key]));
  // Each boss's number is a median over your kills of it; with a single kill the
  // "median" IS that one kill -- too noisy to name as a specific offender (the
  // repo's don't-trust-one-kill rule). Require >=2 kills to call a boss out, and
  // carry the count so the prescription can show how well-backed each callout is.
  const rangeBosses = perBoss
    .map((c) => [c.you.rangeLostPerMin - c.peer.rangeLostPerMin, c.boss, c.yourKills])
    .sort((a, b) => b[0] - a[0]);
  return {
    nBosses: perBoss.length,
    pressExcess: med("pressLostPerMin"),
    rangeExcess: med("rangeLostPerMin"),
    totalExcess: med("lostPerMin"),
    overshootExcess: med("overshootMs"),
    worstRange: rangeBosses
      .filter(([d, , kills]) => d > 1.5 && kills >= 2)
      .map(([, b, kills]) => `${b} (${kills} kills)`),
  };
}

// Consumables you apply yourself -- one row per consumable, same logic for all:
// you ran none -> recommend the field's most common; you ran a different one ->
// swap to it. (Replaces five near-identical hand-written blocks.)
const CONSUMABLES = [
  { field: "flasks", mine: "flask", label: "FLASK", peerVerb: "run", note: "",
    none: DPS(2), missText: "you ran none", tail: "Free parse with equal gear.", swap: DPS(2) },
  { field: "foods", mine: "food", label: "FOOD", peerVerb: "run", note: "",
    none: DPS(1, 2), missText: "you ate none", tail: "Free parse.", swap: DPS(1) },
  { field: "potions", mine: "potion", label: "COMBAT POTION", peerVerb: "pop",
    note: " (pre-pull + again on cooldown/burst = 2 per fight)",
    none: DPS(1, 3), missText: "you used none", tail: "Free parse with equal gear.", swap: DPS(1) },
  { field: "augRunes", mine: "augrune", label: "AUGMENT RUNE", peerVerb: "use",
    note: " (a flat primary-stat gain)",
    none: DPS(1, 2), missText: "you ran none", tail: "Free parse.", swap: DPS(1) },
  { field: "oils", mine: "oil", label: "WEAPON OIL", peerVerb: "apply",
    note: " (a temporary weapon buff, re-applied like a flask)",
    none: DPS(1, 2), missText: "you ran none", tail: "Free parse.", swap: DPS(1) },
];

// --- cross-cutting levers prescribe builds from its OWN peer aggregates ------
// (gear/rotation/comp levers live in their domain modules; these need data only
// prescribe gathers: cross-boss execution, field consumables/enchants, stat gap.)
// Each returns Finding[].

// GCD overshoot (ms past the global) this much above peers reads as input latency
// rather than noise -- below it, it's not worth a callout.
const LATENCY_MS = 30;

// Input/queue latency: a high GCD overshoot vs peers means a delay after EVERY
// global before your next cast fires -- world latency, no spell-queue window, or
// reaction time. Tiny per-GCD but it's every GCD, so it compounds over a fight.
// Distinct from press-faster (idle gaps): this is the cast firing late, not not
// pressing. For a clean player (e.g. a caster who never moves) it's often the
// single biggest thing they actually control.
export function latencyLever(execd) {
  if (!execd || !(execd.overshootExcess >= LATENCY_MS)) return [];
  return [finding("Execution", DPS(1, 3),
    `INPUT LATENCY: your cast fires ~${f(execd.overshootExcess, 0)}ms later than peers after every GCD -- a small delay on each global that adds up over a fight. ` +
    `Raise your spell-queue window (Options > Combat, or /console SpellQueueWindow 300-400), cut world latency, and pre-press your next ability so it queues.`)];
}

export function executionLevers(execd, rot, peerGapPct = null) {
  if (!execd) return [];
  const out = [];
  // Size press-faster from the MEASURED cast deficit (you cast N fewer damaging
  // abilities/min than the field) when that's bigger than the idle-time proxy --
  // the idle-seconds estimate under-counts (it misses slow-but-not-idle play).
  // BUT a cast deficit does NOT convert 1:1 to DPS: the missing GCDs trend toward
  // lower-value fillers, some are non-damage presses, and part of the deficit IS
  // the rotation lever (a skipped core button lowers your cast count too). So damp
  // it (~half), cap at the actual headroom (the measured DPS gap to the field),
  // and hold a hard ceiling -- one execution lever must never claim the whole gap
  // (the old code piped the raw 44% cast gap straight in and dominated the list).
  const cg = rot && rot.castGap;
  const idlePct = Math.round(execd.pressExcess / 60 * 100);
  // The RESIDUAL cast deficit, after subtracting the abilities you're outright
  // MISSING (rot.usage.under -- the field presses them, you don't), is the part
  // that's genuinely "press faster" vs "press the right buttons". Counting the
  // whole deficit double-booked it with the rotation lever (Woeforged: a 12% press
  // lever AND a "press Shield of the Righteous" lever for the same missed casts).
  const under = (rot && rot.usage && rot.usage.under) || [];
  const underGap = under.reduce((s, a) => s + (a.gap || 0), 0);
  const speedPct = (cg && cg.field > 0)
    ? Math.round(100 * Math.max(0, (cg.field - cg.you) - underGap) / cg.field) : 0;
  // Is the press gap latency-driven? High GCD overshoot vs peers means the gaps
  // are a delay after each global (covered by latencyLever), not pure idling --
  // so don't tell them "it's not latency" when it actually is.
  const latencyHigh = execd.overshootExcess >= LATENCY_MS;
  if (execd.pressExcess >= 1.0 || speedPct >= 3) {
    const castEst = Math.round(speedPct / 2);
    const headroomCap = (peerGapPct && peerGapPct > 0) ? Math.max(1, Math.ceil(peerGapPct * 0.6)) : Infinity;
    const pct = Math.min(Math.max(idlePct, castEst) || 1, headroomCap, 12);
    const cite = (cg && cg.field > 0)
      ? (speedPct >= 3
          ? ` You cast ${f(cg.you, 0)} damaging abilities/min vs the field's ${f(cg.field, 0)} -- ~${speedPct}% of that is raw speed (the rest is the rotation fix); the % here estimates the DPS it's worth.`
          : ` (Your lower cast rate -- ${f(cg.you, 0)} vs ${f(cg.field, 0)}/min -- is mostly the rotation fix above, not raw speed.)`)
      : "";
    const cause = latencyHigh
      ? "gaps between GCDs (partly input latency -- see the INPUT LATENCY item)."
      : "not latency (yours matches theirs), just gaps between GCDs.";
    out.push(finding("Execution", DPS(pct),
      `PRESS FASTER (every boss): you idle ~${f(execd.pressExcess, 1)}s/min MORE than peers while IN melee range -- ${cause}${cite} Always queue your next ability so a GCD never sits empty.`));
  }
  out.push(...latencyLever(execd));
  if (execd.rangeExcess >= 1.0 || execd.worstRange.length) {
    const where = execd.worstRange.length ? " Worst on: " + execd.worstRange.join(", ") + "." : "";
    out.push(finding("Execution", DPS(Math.round(Math.max(execd.rangeExcess, 0.1) / 60 * 100)),
      `UPTIME on specific fights: you're out of melee ~${f(execd.rangeExcess, 1)}s/min more than peers (intermissions excluded).${where} Pre-position and use your mobility / gap-closers to stay on target through mechanics.`));
  }
  return out;
}

function consumableLevers(field, my) {
  const out = [];
  for (const cn of CONSUMABLES) {
    const counter = field[cn.field];
    if (!counter.size) continue;
    const top = topEntry(counter)[0];                        // field's most common, by count
    const mineName = my[cn.mine], mineGuid = my[cn.mine + "Guid"];
    if (!mineName) {
      out.push(finding("Setup", cn.none, `${cn.label}: ${cn.missText} -- ${counter.get(top)}/${field.n} peers ` +
        `${cn.peerVerb} ${wowheadSpell(field.guids.get(top), top)}${cn.note}. ${cn.tail}`));
    } else if (mineName !== top) {
      out.push(finding("Setup", cn.swap, `${cn.label}: ${wowheadSpell(mineGuid, mineName)} -> ${wowheadSpell(field.guids.get(top), top)}.`));
    }
  }
  return out;
}

// Missing enchants (the modern "oil"): slots the field reliably enchants that
// you left bare -- a free parse, same as a flask.
function enchantLevers(field, my) {
  const missing = [];
  for (const [slotName, counter] of Object.entries(field.enchBySlot)) {
    if (my.ench.has(slotName)) continue;                 // you already enchant this slot
    const top = topEntry(counter);
    if (top && top[1] >= field.n / 2) missing.push([slotName, top[0]]);  // field reliably enchants it
  }
  if (!missing.length) return [];
  const est = Math.min(missing.length, 5);
  const list = missing.map(([s, e]) => `${s} (${e})`).join(", ");
  return [finding("Setup", DPS(est), `ENCHANTS: you're missing enchants on ${list}. The field runs them -- a free parse with equal gear.`)];
}

// Your secondary % trails the field but there's no lever to close it -- either
// every item is already maxed for the stat (gear/comp-locked), or your gear is
// optimal for what you own. Only fires when gearLevers found no swap/restat
// (those ARE the actionable version of this gap).
function statGapLever(gf, my, field, priority) {
  const PRI = priority.toUpperCase();
  const statGap = (my.statPct !== null && field && field.statPct) ? field.statPct - my.statPct : 0;
  const hasGearLever = gf && (gf.swaps.length || gf.restats.length);
  if (statGap >= 4 && !hasGearLever) {
    return [finding("Gear", INFO, `${PRI}: yours (${f(my.statPct, 0)}%) is below your peers (${f(field.statPct, 0)}%), but NOT actionable now -- every item you own is already ${priority}-maxed and no ${priority}-itemized upgrade exists to swap to. It only rises when ${priority}-itemized drops come.`)];
  }
  if (gf && !gf.swaps.length && !gf.restats.length && statGap < 4) {
    return [finding("Gear", INFO, "GEAR/STATS: optimal for what you own -- no lever; gains are future drops + a sim (Droptimizer).")];
  }
  return [];
}

// THE SYNTHESIS, rendered: one answer anchored on the MEASURED DPS gap (your
// kill vs the ilvl-matched field vs the top parses -- real numbers, not a sum of
// per-lever guesses), what that gap is made of, then the change-list split into
// "yours to do" vs raid comp. Pure presentation -- the analysis already happened.
function renderPrescription(log, d) {
  const { rx, you, field, execd, rot, tp, gf, priority } = d;
  const isComp = (r) => r.dim === "Comp";                  // raid-dependent, not yours to press
  const yours = rx.filter((r) => r.impact > 0 && !isComp(r));
  const k = (n) => `${f((n || 0) / 1000, 1)}k`;
  const peerGap = (you && you.dps && field && field.dpsMed) ? Math.round(((field.dpsMed - you.dps) / you.dps) * 100) : null;
  const topGap = (tp && tp.dpsGapPct) ? Math.round(tp.dpsGapPct) : null;

  log("");
  log(`=== How to parse better — ${d.name}-${d.server} (${d.specName} ${d.className}), ilvl ~${d.curIlvl} ===`);
  if (d.medP != null) log(`You parse ${d.medP}th percentile on ${d.difficultyName} (median of the ${d.nBosses} current-tier ${d.difficultyName} boss${d.nBosses === 1 ? "" : "es"} you've killed; best ${d.bestP}th on ${d.topParse.encounter.name}).`);
  if (d.skipped && d.skipped.length) {
    log(`NOTE: partial list -- couldn't load ${d.skipped.join(", ")} (likely the WCL rate limit). This isn't the full picture; re-run when the budget resets for the rest.`);
  }
  if (peerGap != null) {
    const vsField = peerGap > 0 ? `${peerGap}% behind` : `${Math.abs(peerGap)}% ahead of`;
    log(`Measured on ${d.gearBoss.encounter.name}: you do ${k(you.dps)} DPS -- ${vsField} the ilvl-matched field (${k(field.dpsMed)})` +
        (topGap != null ? `, ${topGap}% behind the top parses` : "") + `. That gap is your headroom.`);
  }
  // A blunt, character-specific VERDICT: name the situation so the report never
  // reads like a template -- and always points at an action (respec / the few
  // setup fixes / "tighten your play, there's no shortcut").
  const compList0 = rx.filter(isComp);
  const setupFixes = yours.filter((r) => r.dim === "Gear" || r.dim === "Setup");
  const hasBuild = yours.some((r) => /^TALENTS\/BUILD/.test(r.text));
  if (hasBuild) {
    log("VERDICT: your biggest lever is a TALENT/BUILD fix -- you're not pressing an ability the field leans on (see #1). Sort that first, then do the free enchant/gear fixes below.");
  } else if (setupFixes.length) {
    log(`VERDICT: your build & rotation already match the field -- your character levers are the ${setupFixes.length} gear/setup fix${setupFixes.length > 1 ? "es" : ""} below + pressing faster. The big gap is ${compList0.length ? "comp + " : ""}reps, not a setup overhaul.`);
  } else {
    log(`VERDICT: build, gear, enchants, and rotation all match the field -- there's NO setup or talent fix to make. Your gap is ${compList0.length ? "comp + " : ""}execution (press faster / uptime). Tighten your play; there's no gear/talent shortcut.`);
  }
  if (yours.length) log(`Biggest fix YOU control: ${rxHeadline(yours[0].text)} -- start here.`);
  // What the gap is made of -- MEASURED quantities (no per-lever DPS guess).
  const facts = [];
  if (execd && execd.totalExcess >= 1) facts.push(`Execution -- you lose ${f(execd.totalExcess, 1)}s/min of GCD uptime vs peers`);
  if (rot && rot.usage && rot.usage.under.length) { const a = rot.usage.under[0]; facts.push(`Rotation -- you press ${a.name} ${f(a.you, 1)}/min vs the field's ${f(a.field, 1)}`); }
  if (tp && tp.routing && (tp.routing.top - tp.routing.you) >= 5) facts.push(`Routing -- ${f(tp.routing.you, 0)}% of your damage hits adds vs the top parses' ${f(tp.routing.top, 0)}%`);
  if (tp && tp.buffGaps) { const g = tp.buffGaps.find((x) => x.comp); if (g) facts.push(`Comp -- you're missing ${g.name} (${f(g.you, 0)}% vs ${f(g.top, 0)}% uptime; raid-dependent)`); }
  if (gf && gf.swaps.length) facts.push(`Gear -- ${gf.swaps.length} ${priority}-itemized upgrade${gf.swaps.length > 1 ? "s" : ""} the field runs (DPS value needs a sim)`);
  if (facts.length) { log("--- What the gap is made of (measured) ---"); for (const ff of facts) log(`  ${ff}`); }
  log(`(Field = top-ranked players at your item level; top parses = the rank-1 kills.)`);

  // Split the list by what's YOURS to do vs raid comp. The whole point is "what
  // do I do to my character right now" -- a roster gap (bring an Aug Evoker) is
  // real but isn't a change you make to your character, so it never competes for
  // the top of the to-do list; it's a clearly-labelled footnote. Each section
  // stays sorted biggest-DPS-first.
  const compList = rx.filter((r) => isComp(r));
  const youList = rx.filter((r) => !isComp(r));
  const line = (r, i) => log(`  ${i + 1}. [${r.label.padStart(9)}]  ${r.text}`);

  log("");
  log("--- Do these to your character now (biggest first; gear/rotation % are sim estimates, the rest measured) ---");
  if (!youList.length) {
    log("  You match your peers on gear, enchants, consumables, stats, and execution. The rest is comp + farm kills.");
  }
  youList.forEach(line);

  if (compList.length) {
    log("");
    log("--- Raid comp (real DPS, but a roster/buff gap — NOT something you change on your character) ---");
    compList.forEach(line);
  }
  log("");
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster",
  difficulty = 5, knownPriority = null) {
  // Healers have no DPS rotation -- a "press faster / more Smites" list is
  // nonsense (e.g. "205% behind, press Smite 45/min" for a Holy Priest). The
  // tool optimizes DPS; for a healing spec, say so and skip rather than emit
  // garbage. Bails before any query, so it costs nothing.
  if (isHealer(specName)) {
    log("");
    log(`${name}-${server} is a healing spec (${specName} ${className}). This tool optimizes DPS,`);
    log("which isn't a healer's metric -- no DPS prescription. (Healing/HPS analysis is out of scope.)");
    return;
  }
  const c = await characterZone(name, server, region, difficulty);
  const ranks = (c.zoneRankings.rankings || []).filter(
    (r) => (r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined);
  if (!ranks.length) throw new Error("No kills found.");

  // Where you parse NOW -- the ground truth the player is trying to raise.
  const parses = ranks.map((r) => r.rankPercent).filter((x) => x != null);
  const medP = parses.length ? Math.round(median(parses)) : null;
  const topParse = ranks.reduce((a, b) => ((a.rankPercent || 0) >= (b.rankPercent || 0) ? a : b));
  const bestP = Math.round(topParse.rankPercent || 0);

  // Highest-ilvl kill = current gear.
  const kills = [];
  for (const r of ranks) {
    const bk = await bestIlvlKill(name, server, region, r.encounter.id, difficulty);
    if (bk) kills.push({ ilvl: bk[2] || 0, boss: r, code: bk[0], fight: bk[1] });
  }
  kills.sort((a, b) => b.ilvl - a.ilvl);
  const { ilvl: curIlvl, boss: gearBoss, code, fight } = kills[0];
  // Stat priority derived from what the field stacks -- never hard-coded. The
  // caller (app/CLI) already detected it; reuse it instead of re-sampling the
  // field's secondary stats (a whole peer fetch) again.
  const priority = knownPriority || await detectPriority(className, specName, difficulty, gearBoss.encounter.id);
  // The PRESCRIPTION is the payoff -- it must survive a mid-run rate limit, not be
  // the section that gets cut. So EVERY data input is fail-soft: a throttled (or
  // private-log) fetch drops just its own levers, and we render the rest from what
  // we did get (often already cached by the earlier cards). Better a partial list
  // than nothing. The reason is logged so a thin list isn't mistaken for "clean".
  const skipped = [];
  const soft = async (what, p) => { try { return await p; } catch (e) { skipped.push(what); return null; } };
  let you = null, my = null;
  try {
    you = await playerMetrics(code, fight, name, specName, className);
    if (you) my = await mySetup(code, fight, you.sourceID, you.gear, priority, className);
  } catch (e) { skipped.push("your gear/consumables"); }

  const field = await soft("the peer field (consumables/enchants/stat gap)",
    fieldGearConsumables(gearBoss.encounter.id, difficulty, className, specName, curIlvl, priority));
  const execd = await soft("execution timeline",
    aggregateExecution(name, server, region, difficulty, className, specName, ranks));
  const gf = await soft("gear audit",
    gearFindings(name, server, region, difficulty, className, specName, priority));
  // rot/tp are hoisted so the synthesis below can quote their MEASURED numbers.
  // Each may be unavailable (private logs, no peers) -- treat that as no findings.
  let rot = null, tp = null, tal = null;
  try { rot = await rotationFindings(name, server, region, className, specName, difficulty); }
  catch (e) { skipped.push("rotation"); }
  try { tp = await topParseFindings(name, server, region, difficulty, className, specName); }
  catch (e) { skipped.push("top-parse comparison"); }
  try { tal = await talentFindings(name, server, region, className, specName, difficulty); }
  catch (e) { skipped.push("talents"); }

  // Fold every domain's levers into ONE list of findings, then sort biggest-DPS
  // first. impact is a real number, so the order can't disagree with the shown
  // labels (the old bug was sorting by a separate, stale key). Each domain owns
  // its own lever-building; prescribe just concatenates.
  // Measured DPS gap to the field -- the true headroom that caps the press-faster
  // estimate so no single execution lever can claim more than the whole gap.
  const peerGapPct = (you && you.dps && field && field.dpsMed) ? Math.round(((field.dpsMed - you.dps) / you.dps) * 100) : null;
  /** @type {Finding[]} */
  const rx = [
    ...executionLevers(execd, rot, peerGapPct),
    ...(field && my ? consumableLevers(field, my) : []),
    ...(field && my ? enchantLevers(field, my) : []),
    ...gearLevers(gf, priority),
    ...(my ? statGapLever(gf, my, field, priority) : []),
    ...rotationLevers(rot),
    ...talentLevers(tal),
    ...topParseLevers(tp),
  ];
  rx.sort((a, b) => b.impact - a.impact);

  renderPrescription(log, {
    name, server, className, specName, curIlvl, gearBoss,
    difficultyName: DIFFICULTY[difficulty] || `difficulty ${difficulty}`,
    medP, bestP, topParse, nBosses: ranks.length,
    you, field, execd, rot, tp, gf, priority, rx, skipped,
  });
}
