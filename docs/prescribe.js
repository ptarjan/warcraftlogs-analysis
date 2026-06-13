// Generate a concrete, prioritized prescription. Ported from prescribe.py.
import {
  ENCHANTABLE_SLOTS, characterZone, characterEncounter, playerMetrics,
  collectPeers, secondaryStats, buffUptimes, median, f, detectPriority, mapLimit, topEntry, bestRank,
} from "./core.js";
import { timelineFindings } from "./timeline.js";
import { gearFindings, sourceText } from "./gear.js";
import { wowheadItem, wowheadSpell } from "./links.js";
import { rotationFindings } from "./rotation.js";
import { topParseFindings } from "./topparse.js";

const SLOT_NAME = ENCHANTABLE_SLOTS;

// A finding is { dim, impact, label, text }:
//   dim    -- which analysis it came from (set explicitly at creation, never
//             re-parsed out of the text), used to split "yours" from "comp".
//   impact -- numeric DPS %, the ONLY thing the list sorts by (biggest first).
//   label  -- the matching display string ("~3% DPS", "~1-3% DPS", "info").
// DPS()/COMP()/INFO build impact and label together so they can never disagree
// (the old bug: a separate sort key that drifted from the shown %).
export const DPS = (lo, hi = lo) => ({ impact: (lo + hi) / 2, label: hi > lo ? `~${lo}-${hi}% DPS` : `~${lo}% DPS` });
export const COMP = (pct) => ({ impact: pct, label: `~${pct}% comp` });
export const INFO = { impact: 0, label: "info" };

// A short headline for a finding (its keyword + first action clause), for naming
// the #1 lever in the synthesis without dumping the whole sentence.
export function rxHeadline(text) {
  const head = String(text).split(/ -- |;|\(/)[0].trim();
  return head.length > 72 ? head.slice(0, 69) + "…" : head;
}

// ONE embellishment finding (not two): name the specific items to craft, in the
// slots of the field's #1 combo -- "craft X on Back", not "fill a slot" + "pick
// a combo" as separate lines. You get 2 embellished slots total. Returns a
// { dim, impact, label, text } finding, or null when your embellishments already
// match a top combo. Pure (takes gearFindings output) so it's unit-testable.
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
  return { dim: "Gear", ...DPS(2, 4), text: msg };
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
  const rangeBosses = perBoss
    .map((c) => [c.you.range_lost_per_min - c.peer.range_lost_per_min, c.boss])
    .sort((a, b) => b[0] - a[0]);
  return {
    nBosses: perBoss.length,
    pressExcess: med("press_lost_per_min"),
    rangeExcess: med("range_lost_per_min"),
    totalExcess: med("lost_per_min"),
    overshootExcess: med("overshoot_ms"),
    worstRange: rangeBosses.filter(([d]) => d > 1.5).map(([, b]) => b),
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

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster",
  difficulty = 5, knownPriority = null) {
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
  const PRI = priority.toUpperCase();
  const you = await playerMetrics(code, fight, name, specName, className);
  const my = await mySetup(code, fight, you.sourceID, you.gear, priority, className);

  const field = await fieldGearConsumables(gearBoss.encounter.id, difficulty, className, specName, curIlvl, priority);
  const execd = await aggregateExecution(name, server, region, difficulty, className, specName, ranks);

  const rx = []; // findings: { dim, impact, label, text }
  const add = (dim, score, text) => rx.push({ dim, ...score, text });

  if (execd) {
    if (execd.pressExcess >= 1.0) {
      add("Execution", DPS(Math.round(execd.pressExcess / 60 * 100)),
        `PRESS FASTER (every boss): you idle ~${f(execd.pressExcess, 1)}s/min MORE than peers while IN melee range -- not latency (yours matches theirs), just gaps between GCDs. Always queue your next ability so a GCD never sits empty.`);
    }
    if (execd.rangeExcess >= 1.0 || execd.worstRange.length) {
      const where = execd.worstRange.length ? " Worst on: " + execd.worstRange.join(", ") + "." : "";
      add("Execution", DPS(Math.round(Math.max(execd.rangeExcess, 0.1) / 60 * 100)),
        `UPTIME on specific fights: you're out of melee ~${f(execd.rangeExcess, 1)}s/min more than peers (intermissions excluded).${where} Pre-position and use your mobility / gap-closers to stay on target through mechanics.`);
    }
  }

  for (const cn of CONSUMABLES) {
    const counter = field[cn.field];
    if (!counter.size) continue;
    const top = topEntry(counter)[0];                        // field's most common, by count
    const mineName = my[cn.mine], mineGuid = my[cn.mine + "Guid"];
    if (!mineName) {
      add("Setup", cn.none, `${cn.label}: ${cn.missText} -- ${counter.get(top)}/${field.n} peers ` +
        `${cn.peerVerb} ${wowheadSpell(field.guids.get(top), top)}${cn.note}. ${cn.tail}`);
    } else if (mineName !== top) {
      add("Setup", cn.swap, `${cn.label}: ${wowheadSpell(mineGuid, mineName)} -> ${wowheadSpell(field.guids.get(top), top)}.`);
    }
  }
  // Missing enchants (the modern "oil"): slots the field reliably enchants that
  // you left bare -- a free parse, same as a flask. enchBySlot already holds the
  // field's most-common enchant per slot; flag the ones you're missing.
  const missingEnch = [];
  for (const [slotName, counter] of Object.entries(field.enchBySlot)) {
    if (my.ench.has(slotName)) continue;                 // you already enchant this slot
    const top = topEntry(counter);
    if (top && top[1] >= field.n / 2) missingEnch.push([slotName, top[0]]);  // field reliably enchants it
  }
  if (missingEnch.length) {
    const est = Math.min(missingEnch.length, 5);
    const list = missingEnch.map(([s, e]) => `${s} (${e})`).join(", ");
    add("Setup", DPS(est), `ENCHANTS: you're missing enchants on ${list}. The field runs them -- a free parse with equal gear.`);
  }

  const gf = await gearFindings(name, server, region, difficulty, className, specName, priority);
  const statGap = (my.statPct !== null && field.statPct) ? field.statPct - my.statPct : 0;
  let howToStat = false;
  if (gf) {
    for (const sw of gf.swaps) {
      howToStat = true;
      const from = sourceText(sw.source, sw.instance, sw.dropChance);
      add("Gear", DPS(1, 3), `${PRI} via ${sw.slot}: replace ${wowheadItem(sw.fromId, sw.fromName)} with ${wowheadItem(sw.toId, sw.toName)} (+${sw.gain} ${priority}${from} -- sim to confirm).`);
    }
    for (const rs of gf.restats) {
      howToStat = true;
      add("Gear", DPS(1, 2), `${PRI} via ${rs.slot}: ${wowheadItem(rs.itemId, rs.itemName)} is selectable -- recraft to ${rs.achievable} ${priority} (you have ${rs.current}).`);
    }
    const embRx = embellishmentRx(gf);
    if (embRx) rx.push(embRx);
  }
  if (statGap >= 4 && !howToStat) {
    add("Gear", INFO, `${PRI}: yours (${f(my.statPct, 0)}%) is below your peers (${f(field.statPct, 0)}%), but NOT actionable now -- every item you own is already ${priority}-maxed and no ${priority}-itemized upgrade exists to swap to. It only rises when ${priority}-itemized drops come.`);
  } else if (gf && !gf.swaps.length && !gf.restats.length && statGap < 4) {
    add("Gear", INFO, "GEAR/STATS: optimal for what you own -- no lever; gains are future drops + a sim (Droptimizer).");
  }

  // Rotation: only a GENUINE proc you under-use is actionable. Crit-driven big
  // hits are deliberately NOT recommended (a big hit is usually just a crit).
  // `rot`/`tp` are hoisted so the synthesis can quote their MEASURED numbers.
  let rot = null, tp = null;
  try {
    rot = await rotationFindings(name, server, region, className, specName, difficulty);
    // Biggest rotation lever: where your ability USAGE diverges from the field.
    // Pressing the wrong button (over-use one ability, never press the one the
    // field uses) or skipping a damage cooldown is usually the largest gap for an
    // underperformer -- so this sorts above gear. Impact is an estimate (we can't
    // sim it), sized by whether it's a wrong-button swap vs just under-use.
    const u = rot && rot.usage;
    if (u && u.under.length) {
      const top = u.under[0];
      const overTop = u.over[0];
      // If you NEVER cast an ability the field leans on, it's almost certainly a
      // missing talent, not a priority slip -- you can't press what you don't
      // have. That's a build/respec fix (a real change to your character), so we
      // say so instead of "press it more". (We can name the ability reliably; we
      // can't name the talent NODE -- talentTree ids aren't spell ids -- but the
      // ability tells you which build to copy.)
      const neverPress = top.you < 0.2 && top.field >= 1.5;
      if (neverPress) {
        add("Rotation", DPS(5, 10),
          `TALENTS/BUILD: you never press ${top.name}, but the field casts it ${f(top.field, 1)}/min -- ` +
          `you're almost certainly missing the talent that grants it. Respec to the field's build ` +
          `(the one with ${top.name}); your rotation can't include it until you do.` +
          (overTop ? ` Right now you spend those globals on ${overTop.name}.` : ""));
      } else {
        const under = u.under.slice(0, 2).map((a) => `${a.name} (peers ${f(a.field, 1)}/min vs your ${f(a.you, 1)})`);
        const wrongButton = u.over.length > 0;
        const over = wrongButton
          ? `; you over-press ${u.over.slice(0, 1).map((a) => `${a.name} (your ${f(a.you, 1)}/min vs peers ${f(a.field, 1)})`).join("")}`
          : "";
        add("Rotation", wrongButton ? DPS(5, 10) : DPS(3, 6),
          `ROTATION: press ${under.join(" and ")} more${over} -- match your peers' ability priority ` +
          `(likely your biggest lever; verify in a log/sim).`);
      }
    }
    if (rot && rot.proc.isReal && rot.proc.fieldPerMin != null &&
        rot.proc.youPerMin < rot.proc.fieldPerMin - 0.4) {
      add("Rotation", DPS(1, 2), `PROC: you land ${f(rot.proc.youPerMin, 1)} ${rot.proc.name} ` +
        `procs/min vs your peers' ${f(rot.proc.fieldPerMin, 1)} -- generate/use it more.`);
    }
  } catch (e) { /* rotation data unavailable -- skip */ }

  // Chasing 99: levers beyond your own play -- the standard raid-comp damage
  // amps your kill is missing, plus damage routing and potions from the actual
  // top parses. These are usually the difference between a mid parse and a 95+.
  try {
    tp = await topParseFindings(name, server, region, difficulty, className, specName);
    if (tp) {
      // Raid-comp amps missing from your kill (a buff on you, or a debuff on the
      // boss). You can't press these -- it's who's in the raid -- so they're
      // labelled "comp" and sized by the effect's rough value.
      for (const e of (tp.comp ? tp.comp.missing : [])) {
        add("Comp", COMP(e.est),
          `COMP: your kill is missing ${e.label} (${e.effect}) -- bring ${e.who}. ` +
          `A raid-comp gap, not execution; it lifts the whole raid's damage.`);
      }
      // Damage routing: measured extra cleave/funnel the top parses get.
      const route = tp.routing ? tp.routing.top - tp.routing.you : 0;
      if (tp.routing && route >= 5 && tp.routing.addNames.length) {
        add("Comp", DPS(Math.round(route)),
          `ROUTING: top parses put ${f(tp.routing.top, 0)}% of damage on ${tp.routing.addNames.join(", ")} ` +
          `(you ${f(tp.routing.you, 0)}%). Cleave/funnel those instead of tunneling the boss.`);
      }
      // Potions: pre-pot + a second combat potion (a setup fix you apply yourself).
      if (tp.potions && tp.potions.top > tp.potions.you) {
        add("Setup", DPS(2),
          `POTIONS: top parses use ${tp.potions.top}/kill (pre-pot + a combat potion); you used ${tp.potions.you}. Add the missing one.`);
      }
    }
  } catch (e) { /* top-parse data unavailable -- skip */ }

  // Biggest DPS first -- impact is a real number now, so the order can't disagree
  // with the displayed labels (the old bug was sorting by a separate, stale key).
  rx.sort((a, b) => b.impact - a.impact);

  // THE SYNTHESIS: pull every analysis into one answer, anchored on the MEASURED
  // DPS gap (your kill vs the ilvl-matched field vs the top parses -- real numbers,
  // not a sum of per-lever guesses), then break that gap into measured facts. The
  // only place we estimate is gear (a stat -> DPS needs a sim), and we say so.
  const isComp = (r) => r.dim === "Comp";                  // raid-dependent, not yours to press
  const yours = rx.filter((r) => r.impact > 0 && !isComp(r));
  const k = (n) => `${f((n || 0) / 1000, 1)}k`;
  const peerGap = (you.dps && field.dpsMed) ? Math.round(((field.dpsMed - you.dps) / you.dps) * 100) : null;
  const topGap = (tp && tp.dpsGapPct) ? Math.round(tp.dpsGapPct) : null;

  log("");
  log("=".repeat(66));
  log(`HOW TO PARSE BETTER -- ${name}-${server} (${specName} ${className}), ilvl ~${curIlvl}`);
  log("=".repeat(66));
  if (medP != null) log(`You parse ${medP}th percentile overall (median of ${ranks.length} bosses; best ${bestP}th on ${topParse.encounter.name}).`);
  if (peerGap != null) {
    const vsField = peerGap > 0 ? `${peerGap}% behind` : `${Math.abs(peerGap)}% ahead of`;
    log(`Measured on ${gearBoss.encounter.name}: you do ${k(you.dps)} DPS -- ${vsField} the ilvl-matched field (${k(field.dpsMed)})` +
        (topGap != null ? `, ${topGap}% behind the top parses` : "") + `. That gap is your headroom.`);
  }
  if (yours.length) log(`Biggest fix YOU control: ${rxHeadline(yours[0].text)} -- start here.`);
  // What the gap is made of -- MEASURED quantities (no per-lever DPS guess).
  const facts = [];
  if (execd && execd.totalExcess >= 1) facts.push(`Execution -- you lose ${f(execd.totalExcess, 1)}s/min of GCD uptime vs peers`);
  if (rot && rot.usage && rot.usage.under.length) { const a = rot.usage.under[0]; facts.push(`Rotation -- you press ${a.name} ${f(a.you, 1)}/min vs the field's ${f(a.field, 1)}`); }
  if (tp && tp.routing && (tp.routing.top - tp.routing.you) >= 5) facts.push(`Routing -- ${f(tp.routing.you, 0)}% of your damage hits adds vs the top parses' ${f(tp.routing.top, 0)}%`);
  if (tp && tp.buffGaps) { const g = tp.buffGaps.find((x) => x.comp); if (g) facts.push(`Comp -- you're missing ${g.name} (${f(g.you, 0)}% vs ${f(g.top, 0)}% uptime; raid-dependent)`); }
  if (gf && gf.swaps.length) facts.push(`Gear -- ${gf.swaps.length} ${priority}-itemized upgrade${gf.swaps.length > 1 ? "s" : ""} the field runs (DPS value needs a sim)`);
  if (facts.length) { log("What the gap is made of (measured):"); for (const ff of facts) log(`  ${ff}`); }
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
  log("DO THESE TO YOUR CHARACTER NOW (biggest first; gear/rotation % are sim estimates, the rest measured):");
  if (!youList.length) {
    log("  You match your peers on gear, enchants, consumables, stats, and execution. The rest is comp + farm kills.");
  }
  youList.forEach(line);

  if (compList.length) {
    log("");
    log("RAID COMP (real DPS, but a roster/buff gap -- NOT something you change on your character):");
    compList.forEach(line);
  }
  log("");
}
