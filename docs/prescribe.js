// Generate a concrete, prioritized prescription. Ported from prescribe.py.
import {
  ENCHANTABLE_SLOTS, characterZone, characterEncounter, playerMetrics,
  topRankings, secondaryStats, buffUptimes, median, f, detectPriority, mapLimit, topEntry,
} from "./core.js";
import { compareBoss } from "./diagnose.js";
import { gearFindings, sourceText } from "./gear.js";
import { wowheadItem, wowheadSpell } from "./links.js";
import { rotationFindings } from "./rotation.js";

const SLOT_NAME = ENCHANTABLE_SLOTS;

// Numeric DPS impact parsed from an item's impact label ("~3% DPS", "~1-3% DPS",
// "info"). Midpoint of any range; "info" -> 0. Used to order the change-list so
// it actually matches the displayed "% DPS" -- "biggest DPS first".
export function impactScore(label) {
  const nums = (String(label).match(/\d+(\.\d+)?/g) || []).map(Number);
  return nums.length ? (Math.min(...nums) + Math.max(...nums)) / 2 : 0;
}

// ONE embellishment finding (not two): name the specific items to craft, in the
// slots of the field's #1 combo -- "craft X on Back", not "fill a slot" + "pick
// a combo" as separate lines. You get 2 embellished slots total. Returns an
// [impact, label, msg] row, or null when your embellishments already match a top
// combo. Pure (takes gearFindings output) so it's unit-testable.
export function embellishmentRx(gf) {
  if (!gf) return null;
  const emb = gf.embellishedSlots || [];
  const ec = gf.emb_compare;
  const matchesTop = ec && ec.your_rank;            // you already run a top combo
  if (!(emb.length < 2 || (ec && !matchesTop && ec.top_combos && ec.top_combos.length))) return null;
  const top = ec && ec.top_combos && ec.top_combos[0];
  const pop = top ? ` (#1 field combo, ${top[1]}/${ec.field_n})` : "";
  const yourSlots = new Set(emb);
  // Short a slot -> name only the slot(s) you're missing; full-but-suboptimal
  // pair -> name the whole target combo to switch to.
  const target = (ec && ec.recommended) ? ec.recommended : [];
  const toCraft = emb.length < 2 ? target.filter(([sl]) => !yourSlots.has(sl)) : target;
  const recText = toCraft.map(([sl, item]) => `${item} (${sl})`).join(" + ");
  let msg;
  if (recText) {
    const lead = emb.length < 2
      ? `you run ${emb.length}/2 -- craft ${recText}`
      : `yours (${ec.your_combo.join("+") || "none"}) isn't one top performers run -- switch to ${recText}`;
    msg = `EMBELLISHMENTS: ${lead}${pop}. Throughput drops can't give.`;
  } else {
    msg = emb.length < 2
      ? `EMBELLISHMENTS: you run ${emb.length}/2 -- fill the free slot${pop}. Throughput drops can't give.`
      : `EMBELLISHMENTS: yours (${ec.your_combo.join("+") || "none"}) isn't one top performers run${top ? `; the #1 combo is ${top[0].join("+")} (${top[1]}/${ec.field_n})` : ""}. Match it.`;
  }
  return [-2.5, "~2-4% DPS", msg];
}

async function bestIlvlKill(name, server, region, encounterId, difficulty) {
  const er = await characterEncounter(name, server, region, encounterId, difficulty);
  if (!er || !er.ranks || !er.ranks.length) return null;
  const best = er.ranks.reduce((a, b) => ((a.bracketData || 0) >= (b.bracketData || 0) ? a : b));
  return [best.report.code, best.report.fightID, best.bracketData];
}

async function fieldGearConsumables(encounterId, difficulty, className, specName, targetIlvl, priority = "crit", n = 10) {
  const enchBySlot = {};   // slot -> Map(name -> count)
  const trinkets = new Map(), flasks = new Map(), foods = new Map();
  const guids = new Map(); // flask/food name -> spell guid (for Wowhead links)
  const statPcts = [];
  // Collect ilvl-matched candidates, then fetch each peer's gear/buffs/stats
  // concurrently (bounded) instead of one slow peer at a time.
  const cands = [];
  for (let page = 1; page <= 7 && cands.length < n + 3; page++) {
    for (const r of await topRankings(encounterId, difficulty, className, specName, page)) {
      const il = r.bracketData;
      if (il && Math.abs(il - targetIlvl) <= 2) cands.push(r);
      if (cands.length >= n + 3) break;
    }
  }
  const peers = (await mapLimit(cands, 5, async (r) => {
    const code = r.report.code, fight = r.report.fightID;
    const m = await playerMetrics(code, fight, r.name, specName, className);
    if (!m) return null;
    const bf = await buffUptimes(code, fight, m.sourceID);
    const s = await secondaryStats(code, fight, m.sourceID);
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
    }
    if (s) {
      const sec = ["crit", "haste", "mastery", "vers"].reduce((acc, k) => acc + s[k], 0) || 1;
      statPcts.push(100 * s[priority] / sec);
    }
  }
  return {
    ench_by_slot: enchBySlot, trinkets, flasks, foods, guids,
    stat_pct: statPcts.length ? median(statPcts) : null, n: peers.length,
  };
}

async function mySetup(code, fight, sourceId, gear, priority = "crit") {
  const bf = await buffUptimes(code, fight, sourceId);
  const flask = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("flask") && b.pct > 50);
  const food = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("well fed") && b.pct > 50);
  const stats = await secondaryStats(code, fight, sourceId);
  const statPct = stats
    ? 100 * stats[priority] / (["crit", "haste", "mastery", "vers"].reduce((a, k) => a + stats[k], 0) || 1)
    : null;
  const trinkets = gear.filter((g) => g.slot === 12 || g.slot === 13).map((g) => g.name);
  const ench = new Set(gear.filter((g) => g.slot in SLOT_NAME && g.permanentEnchant).map((g) => SLOT_NAME[g.slot]));
  return {
    flask: flask ? flask[0] : null, flaskGuid: flask ? flask[1].guid : null,
    food: food ? food[0] : null, foodGuid: food ? food[1].guid : null,
    statPct, trinkets, ench,
  };
}

async function aggregateExecution(name, server, region, difficulty, className, specName, bosses) {
  const perBoss = [];
  for (const r of bosses) {
    let c;
    try { c = await compareBoss(name, server, region, r.encounter, difficulty, className, specName); }
    catch (e) { c = null; }
    if (c) perBoss.push(c);
  }
  if (!perBoss.length) return null;
  const med = (key) => median(perBoss.map((c) => c.you[key] - c.peer[key]));
  const rangeBosses = perBoss
    .map((c) => [c.you.range_lost_per_min - c.peer.range_lost_per_min, c.boss])
    .sort((a, b) => b[0] - a[0]);
  return {
    n_bosses: perBoss.length,
    press_excess: med("press_lost_per_min"),
    range_excess: med("range_lost_per_min"),
    total_excess: med("lost_per_min"),
    overshoot_excess: med("overshoot_ms"),
    worst_range: rangeBosses.filter(([d]) => d > 1.5).map(([, b]) => b),
  };
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster", difficulty = 5) {
  const N = name, S = server, R = region, CL = className, SP = specName, D = difficulty;
  const c = await characterZone(N, S, R, D);
  const ranks = (c.zoneRankings.rankings || []).filter(
    (r) => (r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined);
  if (!ranks.length) throw new Error("No kills found.");

  // Highest-ilvl kill = current gear.
  const encBest = [];
  for (const r of ranks) {
    const bk = await bestIlvlKill(N, S, R, r.encounter.id, D);
    if (bk) encBest.push([bk[2] || 0, r, bk]);
  }
  encBest.sort((a, b) => b[0] - a[0]);
  const [curIlvl, gearBoss, [code, fight]] = encBest[0];
  // Stat priority derived from what the field stacks -- never hard-coded.
  const priority = await detectPriority(CL, SP, D, gearBoss.encounter.id);
  const PRI = priority.toUpperCase();
  const you = await playerMetrics(code, fight, N, SP, CL);
  const my = await mySetup(code, fight, you.sourceID, you.gear, priority);

  log("");
  log("=".repeat(66));
  log(`PRESCRIPTION for ${N}-${S} (${SP} ${CL}) | current ilvl ~${curIlvl}`);
  log(`Aggregated across ${ranks.length} killed bosses; gear from your ${gearBoss.encounter.name} kill; execution normalized vs peers.`);
  log("=".repeat(66));

  const field = await fieldGearConsumables(gearBoss.encounter.id, D, CL, SP, curIlvl, priority);
  const execd = await aggregateExecution(N, S, R, D, CL, SP, ranks);

  const rx = []; // [sortKey, impact, text]

  if (execd) {
    if (execd.press_excess >= 1.0) {
      const pct = execd.press_excess / 60 * 100;
      rx.push([-execd.press_excess, `~${f(pct, 0)}% DPS`,
        `PRESS FASTER (every boss): you idle ~${f(execd.press_excess, 1)}s/min MORE than peers while IN melee range -- not latency (yours matches theirs), just gaps between GCDs. Always queue your next ability so a GCD never sits empty.`]);
    }
    if (execd.range_excess >= 1.0 || execd.worst_range.length) {
      const where = execd.worst_range.length ? " Worst on: " + execd.worst_range.join(", ") + "." : "";
      const pct = Math.max(execd.range_excess, 0.1) / 60 * 100;
      rx.push([-execd.range_excess, `~${f(pct, 0)}% DPS`,
        `UPTIME on specific fights: you're out of melee ~${f(execd.range_excess, 1)}s/min more than peers (intermissions excluded).${where} Pre-position and use your mobility / gap-closers to stay on target through mechanics.`]);
    }
  }

  if (field.flasks.size) {
    const tf = topEntry(field.flasks)[0];
    if (my.flask && my.flask !== tf) {
      rx.push([-2.5, "~2% DPS", `FLASK: ${wowheadSpell(my.flaskGuid, my.flask)} -> ` +
        `${wowheadSpell(field.guids.get(tf), tf)} (${field.flasks.get(tf)}/${field.n} peers).`]);
    }
  }
  if (field.foods.size) {
    const tfo = topEntry(field.foods)[0];
    if (my.food && my.food !== tfo) {
      rx.push([-1.0, "~1% DPS", `FOOD: ${wowheadSpell(my.foodGuid, my.food)} -> ${wowheadSpell(field.guids.get(tfo), tfo)}.`]);
    }
  }

  const gf = await gearFindings(N, S, R, D, CL, SP, priority);
  const statGap = (my.statPct !== null && field.stat_pct) ? field.stat_pct - my.statPct : 0;
  let howToStat = false;
  if (gf) {
    for (const [slot, mine, theirs, amt, cnt, tot, src, chance, instance, theirsId, mineId] of gf.swaps) {
      howToStat = true;
      const from = sourceText(src, instance, chance);
      rx.push([-2.0, "~1-3% DPS", `${PRI} via ${slot}: replace ${wowheadItem(mineId, mine)} with ${wowheadItem(theirsId, theirs)} (+${amt} ${priority}; ${cnt}/${tot} of field${from} -- sim to confirm).`]);
    }
    for (const [slot, name2, mine, best, itemId] of gf.restats) {
      howToStat = true;
      rx.push([-1.5, "~1-2% DPS", `${PRI} via ${slot}: ${wowheadItem(itemId, name2)} is selectable -- recraft to ${best} ${priority} (you have ${mine}).`]);
    }
    const embRx = embellishmentRx(gf);
    if (embRx) rx.push(embRx);
  }
  if (statGap >= 4 && !howToStat) {
    rx.push([0.0, "info", `${PRI}: yours (${f(my.statPct, 0)}%) is below the field (${f(field.stat_pct, 0)}%), but NOT actionable now -- every item you own is already ${priority}-maxed and no ${priority}-itemized upgrade exists to swap to. It only rises when ${priority}-itemized drops come.`]);
  } else if (gf && !gf.swaps.length && !gf.restats.length && statGap < 4) {
    rx.push([0.0, "info", "GEAR/STATS: optimal for what you own -- no lever; gains are future drops + a sim (Droptimizer)."]);
  }

  // Rotation: only a GENUINE proc you under-use is actionable. Crit-driven big
  // hits are deliberately NOT recommended (a big hit is usually just a crit).
  try {
    const rot = await rotationFindings(N, S, R, CL, SP, D);
    // Biggest rotation lever: where your ability USAGE diverges from the field.
    // Pressing the wrong button (over-use one ability, never press the one the
    // field uses) or skipping a damage cooldown is usually the largest gap for an
    // underperformer -- so this sorts above gear. Impact is an estimate (we can't
    // sim it), sized by whether it's a wrong-button swap vs just under-use.
    const u = rot && rot.usage;
    if (u && u.under.length) {
      const under = u.under.slice(0, 2).map((a) => `${a.name} (field ${f(a.field, 1)}/min vs your ${f(a.you, 1)})`);
      const wrongButton = u.over.length > 0;
      const over = wrongButton
        ? `; you over-press ${u.over.slice(0, 1).map((a) => `${a.name} (your ${f(a.you, 1)}/min vs field ${f(a.field, 1)})`).join("")}`
        : "";
      rx.push([wrongButton ? -7.5 : -4.5, wrongButton ? "~5-10% DPS" : "~3-6% DPS",
        `ROTATION: press ${under.join(" and ")} more${over} -- match the field's ability priority ` +
        `(likely your biggest lever; verify in a log/sim).`]);
    }
    if (rot && rot.proc.isReal && rot.proc.fieldPerMin != null &&
        rot.proc.youPerMin < rot.proc.fieldPerMin - 0.4) {
      rx.push([-1.0, "~1-2% DPS", `PROC: you land ${f(rot.proc.youPerMin, 1)} ${rot.proc.name} ` +
        `procs/min vs the field's ${f(rot.proc.fieldPerMin, 1)} -- generate/use it more.`]);
    }
  } catch (e) { /* rotation data unavailable -- skip */ }

  log("");
  log("DO THESE IN ORDER (biggest DPS first):");
  if (!rx.length) {
    log("  You match the field on gear, consumables, stats, and execution. Remaining gains are farm kills + raid comp.");
  }
  // Sort by the actual displayed DPS impact, biggest first -- the order MUST
  // match the "% DPS" the user sees (the bug was an unrelated sort key).
  rx.sort((a, b) => impactScore(b[1]) - impactScore(a[1]));
  rx.forEach(([, impact, text], i) => log(`  ${i + 1}. [${String(impact).padStart(9)}]  ${text}`));
  log("");
}
