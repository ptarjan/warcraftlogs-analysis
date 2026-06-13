// Generate a concrete, prioritized prescription. Ported from prescribe.py.
import {
  ENCHANTABLE_SLOTS, characterZone, characterEncounter, playerMetrics,
  topRankings, secondaryStats, buffUptimes, median, f, detectPriority, mapLimit, topEntry, bestRank,
} from "./core.js";
import { compareBoss } from "./diagnose.js";
import { gearFindings, sourceText } from "./gear.js";
import { wowheadItem, wowheadSpell } from "./links.js";
import { rotationFindings } from "./rotation.js";
import { topParseFindings } from "./topparse.js";

const SLOT_NAME = ENCHANTABLE_SLOTS;

// Numeric DPS impact parsed from an item's impact label ("~3% DPS", "~1-3% DPS",
// "info"). Midpoint of any range; "info" -> 0. Used to order the change-list so
// it actually matches the displayed "% DPS" -- "biggest DPS first".
export function impactScore(label) {
  const nums = (String(label).match(/\d+(\.\d+)?/g) || []).map(Number);
  return nums.length ? (Math.min(...nums) + Math.max(...nums)) / 2 : 0;
}

// Which analysis a finding came from -- groups the levers by area for the
// synthesis "where your DPS leaks" line. Keyed off the finding's leading label.
export function dimensionOf(text) {
  if (/^(PRESS FASTER|UPTIME)/.test(text)) return "Execution";
  if (/^(ROTATION|PROC)/.test(text)) return "Rotation";
  if (/^(FLASK|FOOD|COMBAT POTION|POTIONS|AUGMENT RUNE|ENCHANTS)/.test(text)) return "Setup";
  if (/^(BUFF|ROUTING)/.test(text)) return "Comp";
  return "Gear";   // "<STAT> via ...", EMBELLISHMENTS, GEAR/STATS, re-stat
}

// A short headline for a finding (its keyword + first action clause), for naming
// the #1 lever in the synthesis without dumping the whole sentence.
export function rxHeadline(text) {
  const head = String(text).split(/ -- |;|\(/)[0].trim();
  return head.length > 72 ? head.slice(0, 69) + "…" : head;
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
  const best = bestRank(er && er.ranks);
  if (!best) return null;
  return [best.report.code, best.report.fightID, best.bracketData];
}

async function fieldGearConsumables(encounterId, difficulty, className, specName, targetIlvl, priority = "crit", n = 10) {
  const enchBySlot = {};   // slot -> Map(name -> count)
  const trinkets = new Map(), flasks = new Map(), foods = new Map(), potions = new Map(), augRunes = new Map();
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
      // Combat potions are brief (a few uses), so any uptime counts; exclude heals.
      if (b.pct > 0 && lc.includes("potion") && !lc.includes("healing")) { potions.set(nm, (potions.get(nm) || 0) + 1); guids.set(nm, b.guid); }
      // Augment rune: a persistent +primary-stat consumable (a free flat gain).
      if (b.pct > 50 && lc.includes("augment rune")) { augRunes.set(nm, (augRunes.get(nm) || 0) + 1); guids.set(nm, b.guid); }
    }
    if (s) {
      const sec = ["crit", "haste", "mastery", "vers"].reduce((acc, k) => acc + s[k], 0) || 1;
      statPcts.push(100 * s[priority] / sec);
    }
  }
  return {
    ench_by_slot: enchBySlot, trinkets, flasks, foods, potions, augRunes, guids,
    stat_pct: statPcts.length ? median(statPcts) : null, n: peers.length,
    dps_med: peers.length ? median(peers.map((p) => p.m.dps)) : null, // measured field DPS
  };
}

async function mySetup(code, fight, sourceId, gear, priority = "crit") {
  const bf = await buffUptimes(code, fight, sourceId);
  const flask = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("flask") && b.pct > 50);
  const food = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("well fed") && b.pct > 50);
  const potion = Object.entries(bf).find(([n, b]) => {
    const lc = n.toLowerCase();
    return lc.includes("potion") && !lc.includes("healing") && b.pct > 0;
  });
  const augrune = Object.entries(bf).find(([n, b]) => n.toLowerCase().includes("augment rune") && b.pct > 50);
  const stats = await secondaryStats(code, fight, sourceId);
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

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster",
  difficulty = 5, knownPriority = null) {
  const N = name, S = server, R = region, CL = className, SP = specName, D = difficulty;
  const c = await characterZone(N, S, R, D);
  const ranks = (c.zoneRankings.rankings || []).filter(
    (r) => (r.totalKills || 0) > 0 && r.rankPercent !== null && r.rankPercent !== undefined);
  if (!ranks.length) throw new Error("No kills found.");

  // Where you parse NOW -- the ground truth the player is trying to raise.
  const parses = ranks.map((r) => r.rankPercent).filter((x) => x != null);
  const medP = parses.length ? Math.round(median(parses)) : null;
  const bestRank = ranks.reduce((a, b) => ((a.rankPercent || 0) >= (b.rankPercent || 0) ? a : b));
  const bestP = Math.round(bestRank.rankPercent || 0);

  // Highest-ilvl kill = current gear.
  const encBest = [];
  for (const r of ranks) {
    const bk = await bestIlvlKill(N, S, R, r.encounter.id, D);
    if (bk) encBest.push([bk[2] || 0, r, bk]);
  }
  encBest.sort((a, b) => b[0] - a[0]);
  const [curIlvl, gearBoss, [code, fight]] = encBest[0];
  // Stat priority derived from what the field stacks -- never hard-coded. The
  // caller (app/CLI) already detected it; reuse it instead of re-sampling the
  // field's secondary stats (a whole peer fetch) again.
  const priority = knownPriority || await detectPriority(CL, SP, D, gearBoss.encounter.id);
  const PRI = priority.toUpperCase();
  const you = await playerMetrics(code, fight, N, SP, CL);
  const my = await mySetup(code, fight, you.sourceID, you.gear, priority);

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
    if (!my.flask) {
      rx.push([-2.5, "~2% DPS", `FLASK: you ran none -- ${field.flasks.get(tf)}/${field.n} peers run ` +
        `${wowheadSpell(field.guids.get(tf), tf)}. Free parse with equal gear.`]);
    } else if (my.flask !== tf) {
      rx.push([-2.5, "~2% DPS", `FLASK: ${wowheadSpell(my.flaskGuid, my.flask)} -> ` +
        `${wowheadSpell(field.guids.get(tf), tf)}.`]);
    }
  }
  if (field.foods.size) {
    const tfo = topEntry(field.foods)[0];
    if (!my.food) {
      rx.push([-1.5, "~1-2% DPS", `FOOD: you ate none -- ${field.foods.get(tfo)}/${field.n} peers run ` +
        `${wowheadSpell(field.guids.get(tfo), tfo)}. Free parse.`]);
    } else if (my.food !== tfo) {
      rx.push([-1.0, "~1% DPS", `FOOD: ${wowheadSpell(my.foodGuid, my.food)} -> ${wowheadSpell(field.guids.get(tfo), tfo)}.`]);
    }
  }
  if (field.potions.size) {
    const tp = topEntry(field.potions)[0];
    if (!my.potion) {
      rx.push([-3.0, "~1-3% DPS", `COMBAT POTION: you used none -- ${field.potions.get(tp)}/${field.n} peers pop ` +
        `${wowheadSpell(field.guids.get(tp), tp)} (pre-pull + again on cooldown/burst = 2 per fight). Free parse with equal gear.`]);
    } else if (my.potion !== tp) {
      rx.push([-1.0, "~1% DPS", `COMBAT POTION: ${wowheadSpell(my.potionGuid, my.potion)} -> ${wowheadSpell(field.guids.get(tp), tp)}.`]);
    }
  }
  if (field.augRunes.size) {
    const ta = topEntry(field.augRunes)[0];
    if (!my.augrune) {
      rx.push([-2.0, "~1-2% DPS", `AUGMENT RUNE: you ran none -- ${field.augRunes.get(ta)}/${field.n} peers use ` +
        `${wowheadSpell(field.guids.get(ta), ta)} (a flat primary-stat gain). Free parse.`]);
    } else if (my.augrune !== ta) {
      rx.push([-1.0, "~1% DPS", `AUGMENT RUNE: ${wowheadSpell(my.augruneGuid, my.augrune)} -> ${wowheadSpell(field.guids.get(ta), ta)}.`]);
    }
  }
  // Missing enchants (the modern "oil"): slots the field reliably enchants that
  // you left bare -- a free parse, same as a flask. ench_by_slot already holds
  // the field's most-common enchant per slot; flag the ones you're missing.
  const missingEnch = [];
  for (const [slotName, counter] of Object.entries(field.ench_by_slot)) {
    if (my.ench.has(slotName)) continue;                 // you already enchant this slot
    const top = topEntry(counter);
    if (top && top[1] >= field.n / 2) missingEnch.push([slotName, top[0]]);  // field reliably enchants it
  }
  if (missingEnch.length) {
    const est = Math.min(missingEnch.length, 5);
    const list = missingEnch.map(([s, e]) => `${s} (${e})`).join(", ");
    rx.push([-est, `~${est}% DPS`,
      `ENCHANTS: you're missing enchants on ${list}. The field runs them -- a free parse with equal gear.`]);
  }

  const gf = await gearFindings(N, S, R, D, CL, SP, priority);
  const statGap = (my.statPct !== null && field.stat_pct) ? field.stat_pct - my.statPct : 0;
  let howToStat = false;
  if (gf) {
    for (const [slot, mine, theirs, amt, cnt, tot, src, chance, instance, theirsId, mineId] of gf.swaps) {
      howToStat = true;
      const from = sourceText(src, instance, chance);
      rx.push([-2.0, "~1-3% DPS", `${PRI} via ${slot}: replace ${wowheadItem(mineId, mine)} with ${wowheadItem(theirsId, theirs)} (+${amt} ${priority}${from} -- sim to confirm).`]);
    }
    for (const [slot, name2, mine, best, itemId] of gf.restats) {
      howToStat = true;
      rx.push([-1.5, "~1-2% DPS", `${PRI} via ${slot}: ${wowheadItem(itemId, name2)} is selectable -- recraft to ${best} ${priority} (you have ${mine}).`]);
    }
    const embRx = embellishmentRx(gf);
    if (embRx) rx.push(embRx);
  }
  if (statGap >= 4 && !howToStat) {
    rx.push([0.0, "info", `${PRI}: yours (${f(my.statPct, 0)}%) is below your peers (${f(field.stat_pct, 0)}%), but NOT actionable now -- every item you own is already ${priority}-maxed and no ${priority}-itemized upgrade exists to swap to. It only rises when ${priority}-itemized drops come.`]);
  } else if (gf && !gf.swaps.length && !gf.restats.length && statGap < 4) {
    rx.push([0.0, "info", "GEAR/STATS: optimal for what you own -- no lever; gains are future drops + a sim (Droptimizer)."]);
  }

  // Rotation: only a GENUINE proc you under-use is actionable. Crit-driven big
  // hits are deliberately NOT recommended (a big hit is usually just a crit).
  // `rot`/`tp` are hoisted so the synthesis can quote their MEASURED numbers.
  let rot = null, tp = null;
  try {
    rot = await rotationFindings(N, S, R, CL, SP, D);
    // Biggest rotation lever: where your ability USAGE diverges from the field.
    // Pressing the wrong button (over-use one ability, never press the one the
    // field uses) or skipping a damage cooldown is usually the largest gap for an
    // underperformer -- so this sorts above gear. Impact is an estimate (we can't
    // sim it), sized by whether it's a wrong-button swap vs just under-use.
    const u = rot && rot.usage;
    if (u && u.under.length) {
      const under = u.under.slice(0, 2).map((a) => `${a.name} (peers ${f(a.field, 1)}/min vs your ${f(a.you, 1)})`);
      const wrongButton = u.over.length > 0;
      const over = wrongButton
        ? `; you over-press ${u.over.slice(0, 1).map((a) => `${a.name} (your ${f(a.you, 1)}/min vs peers ${f(a.field, 1)})`).join("")}`
        : "";
      rx.push([wrongButton ? -7.5 : -4.5, wrongButton ? "~5-10% DPS" : "~3-6% DPS",
        `ROTATION: press ${under.join(" and ")} more${over} -- match your peers' ability priority ` +
        `(likely your biggest lever; verify in a log/sim).`]);
    }
    if (rot && rot.proc.isReal && rot.proc.fieldPerMin != null &&
        rot.proc.youPerMin < rot.proc.fieldPerMin - 0.4) {
      rx.push([-1.0, "~1-2% DPS", `PROC: you land ${f(rot.proc.youPerMin, 1)} ${rot.proc.name} ` +
        `procs/min vs your peers' ${f(rot.proc.fieldPerMin, 1)} -- generate/use it more.`]);
    }
  } catch (e) { /* rotation data unavailable -- skip */ }

  // Chasing 99: levers beyond your own play -- the standard raid-comp damage
  // amps your kill is missing, plus damage routing and potions from the actual
  // top parses. These are usually the difference between a mid parse and a 95+.
  try {
    tp = await topParseFindings(N, S, R, D, CL, SP);
    if (tp) {
      // Raid-comp amps missing from your kill (a buff on you, or a debuff on the
      // boss). You can't press these -- it's who's in the raid -- so they're
      // labelled "comp" and sized by the effect's rough value.
      for (const e of (tp.comp ? tp.comp.missing : [])) {
        rx.push([-e.est, `~${e.est}% comp`,
          `COMP: your kill is missing ${e.label} (${e.effect}) -- bring ${e.who}. ` +
          `A raid-comp gap, not execution; it lifts the whole raid's damage.`]);
      }
      // Damage routing: measured extra cleave/funnel the top parses get.
      const route = tp.routing ? tp.routing.top - tp.routing.you : 0;
      if (tp.routing && route >= 5 && tp.routing.addNames.length) {
        rx.push([-route, `~${f(route, 0)}% DPS`,
          `ROUTING: top parses put ${f(tp.routing.top, 0)}% of damage on ${tp.routing.addNames.join(", ")} ` +
          `(you ${f(tp.routing.you, 0)}%). Cleave/funnel those instead of tunneling the boss.`]);
      }
      // Potions: pre-pot + a second combat potion.
      if (tp.potions && tp.potions.top > tp.potions.you) {
        rx.push([-2.5, "~2% DPS",
          `POTIONS: top parses use ${tp.potions.top}/kill (pre-pot + a combat potion); you used ${tp.potions.you}. Add the missing one.`]);
      }
    }
  } catch (e) { /* top-parse data unavailable -- skip */ }

  // Sort by the actual displayed DPS impact, biggest first -- the order MUST
  // match the "% DPS" the user sees (the bug was an unrelated sort key).
  rx.sort((a, b) => impactScore(b[1]) - impactScore(a[1]));

  // THE SYNTHESIS: pull every analysis into one answer, anchored on the MEASURED
  // DPS gap (your kill vs the ilvl-matched field vs the top parses -- real numbers,
  // not a sum of per-lever guesses), then break that gap into measured facts. The
  // only place we estimate is gear (a stat -> DPS needs a sim), and we say so.
  const act = rx.filter((r) => impactScore(r[1]) > 0);
  const isComp = (r) => dimensionOf(r[2]) === "Comp";       // raid-dependent, not yours to press
  const yours = act.filter((r) => !isComp(r));
  const k = (n) => `${f((n || 0) / 1000, 1)}k`;
  const peerGap = (you.dps && field.dps_med) ? Math.round(((field.dps_med - you.dps) / you.dps) * 100) : null;
  const topGap = (tp && tp.dpsGapPct) ? Math.round(tp.dpsGapPct) : null;

  log("");
  log("=".repeat(66));
  log(`HOW TO PARSE BETTER -- ${N}-${S} (${SP} ${CL}), ilvl ~${curIlvl}`);
  log("=".repeat(66));
  if (medP != null) log(`You parse ${medP}th percentile overall (median of ${ranks.length} bosses; best ${bestP}th on ${bestRank.encounter.name}).`);
  if (peerGap != null) {
    const vsField = peerGap > 0 ? `${peerGap}% behind` : `${Math.abs(peerGap)}% ahead of`;
    log(`Measured on ${gearBoss.encounter.name}: you do ${k(you.dps)} DPS -- ${vsField} the ilvl-matched field (${k(field.dps_med)})` +
        (topGap != null ? `, ${topGap}% behind the top parses` : "") + `. That gap is your headroom.`);
  }
  if (yours.length) log(`Biggest fix YOU control: ${rxHeadline(yours[0][2])} -- start here.`);
  // What the gap is made of -- MEASURED quantities (no per-lever DPS guess).
  const facts = [];
  if (execd && execd.total_excess >= 1) facts.push(`Execution -- you lose ${f(execd.total_excess, 1)}s/min of GCD uptime vs peers`);
  if (rot && rot.usage && rot.usage.under.length) { const a = rot.usage.under[0]; facts.push(`Rotation -- you press ${a.name} ${f(a.you, 1)}/min vs the field's ${f(a.field, 1)}`); }
  if (tp && tp.routing && (tp.routing.top - tp.routing.you) >= 5) facts.push(`Routing -- ${f(tp.routing.you, 0)}% of your damage hits adds vs the top parses' ${f(tp.routing.top, 0)}%`);
  if (tp && tp.buffGaps) { const g = tp.buffGaps.find((x) => x.comp); if (g) facts.push(`Comp -- you're missing ${g.name} (${f(g.you, 0)}% vs ${f(g.top, 0)}% uptime; raid-dependent)`); }
  if (gf && gf.swaps.length) facts.push(`Gear -- ${gf.swaps.length} ${priority}-itemized upgrade${gf.swaps.length > 1 ? "s" : ""} the field runs (DPS value needs a sim)`);
  if (facts.length) { log("What the gap is made of (measured):"); for (const ff of facts) log(`  ${ff}`); }
  log(`(Field = top-ranked players at your item level; top parses = the rank-1 kills.)`);

  log("");
  log("DO THESE IN ORDER (biggest first; execution/routing/comp are measured, gear/rotation % are sim estimates):");
  if (!rx.length) {
    log("  You match your peers on gear, consumables, stats, and execution. Remaining gains are farm kills + raid comp.");
  }
  rx.forEach(([, impact, text], i) => log(`  ${i + 1}. [${String(impact).padStart(9)}]  ${text}`));
  log("");
}
