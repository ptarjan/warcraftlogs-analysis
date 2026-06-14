// @ts-check
// Rotation analysis -- CLASS-AGNOSTIC. Works for any spec because it hard-codes
// no ability names or priorities (the bug before: assuming Tiger Palm was a
// filler when an empowered Tiger Palm is actually the biggest hit). Everything
// is derived from the data and compared to the field:
//   - which of YOUR abilities hits hardest (per-hit), for any class
//   - "empowered" hits: abilities with a high cluster of outsized hits (procs);
//     how often you land them vs the field
//   - your opener sequence vs the field's
import {
  playerMetrics, ilvlPeers, mapLimit, median, bestKill,
  reportCore, fightWindow, fightEvents, paginateEvents, f, DPS, finding, eventTable, runIsHealer,
} from "./core.js";
import { talentedAbilities } from "./talents.js";
import { wowheadSpell } from "./links.js";
import { spellTooltip } from "./wcl.js";

// --- pure, unit-tested helpers ----------------------------------------------

// Count "empowered" hits: those far above the ability's own median. Procs form
// a high cluster; baseline hits a low one -- a multiple of the median separates
// them with no hard-coded numbers, so it generalizes across classes.
export function empoweredCount(amounts, factor = 1.8) {
  if (amounts.length < 4) return 0;
  const s = [...amounts].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)] || 0;
  return amounts.filter((a) => a > med * factor).length;
}

export function openerSequence(casts, windowMs = 20000, n = 8) {
  if (!casts.length) return [];
  const t0 = casts[0].t;
  return casts.filter((c) => c.t - t0 <= windowMs).slice(0, n).map((c) => c.name);
}

// --- data layer: everything reads from the shared core loader (reportCore,
// fightWindow, fightEvents, paginateEvents) so a kill's tables/events are fetched
// once across rotation, diagnose, and analyze. -------------------------------

// One player's damage abilities (guid/name/total), highest total first -- from the
// shared loader's DamageDone table (className arg ignored; the table is unfiltered).
async function damageAbilities(code, fight, name, className) {
  const es = (await reportCore(code, fight)).dmg.data.entries || [];
  const e = es.find((x) => x.name === name) || es[0];
  if (!e) return [];
  return (e.abilities || []).filter((a) => a.guid != null && a.total > 0)
    .sort((a, b) => b.total - a.total);
}

// Per-hit stats from raw damage events. Separates crit-driven big hits (a stat
// outcome, not rotation) from genuine empowerment procs (non-crit outsized hits),
// so we never tell someone to "use a proc" when they just need crit.
function perHit(events) {
  const amounts = events.map((x) => x.amount || 0);
  const s = [...amounts].sort((a, b) => a - b);
  const crits = events.filter((x) => x.hitType === 2).length;
  const nonCrit = events.filter((x) => x.hitType !== 2).map((x) => x.amount || 0);
  return {
    count: s.length,
    med: s.length ? s[Math.floor(s.length / 2)] : 0,
    max: s.length ? s[s.length - 1] : 0,
    critPct: s.length ? (100 * crits) / s.length : 0,
    procBig: empoweredCount(nonCrit),   // outsized NON-crit hits = a real proc
  };
}

// Analyze one kill. `topN` damage abilities get per-hit detail (you); peers pass
// `onlyAbility` (a name) to measure just that ability's empowered rate.
async function analyzeKill(name, code, fight, specName, className, opts = {}) {
  const m = await playerMetrics(code, fight, name, specName, className);
  if (!m) return null;
  const [s, e] = await fightWindow(code, fight);
  const dur = (e - s) / 1000;

  // Opener from cast events (names via the damage-ability map is enough here).
  const abils = await damageAbilities(code, fight, m.name, className);
  const id2name = Object.fromEntries(abils.map((a) => [a.guid, a.name]));
  const name2id = Object.fromEntries(abils.map((a) => [a.name, a.guid]));
  const rawCasts = (await fightEvents(code, fight, m.sourceID, s, e)).casts.filter((x) => !x.fake);
  const cpm = dur ? 60 / dur : 0;
  // ALL casts/min keyed by ability id -- the damage table is truncated to ~5
  // abilities, so buff/pet COOLDOWNS (Invoke Niuzao, Weapons of Order) appear ONLY
  // here, not in the damage-derived castRate. Names are resolved later (via Wowhead)
  // for just the few that diverge from the field, so this stays cheap.
  const allCastRate = {};
  for (const x of rawCasts) allCastRate[x.abilityGameID] = (allCastRate[x.abilityGameID] || 0) + 1;
  for (const k of Object.keys(allCastRate)) allCastRate[k] *= cpm;

  const casts = rawCasts
    .filter((x) => id2name[x.abilityGameID])
    .map((x) => ({ t: x.timestamp - s, name: id2name[x.abilityGameID] }))
    .sort((a, b) => a.t - b.t);
  if (casts.length < 5) return null;

  // Casts/min per ability over the whole fight -- the basis for "do you press
  // what the field presses". Free: we already have every (damage) cast here.
  const castRate = {};
  for (const c of casts) castRate[c.name] = (castRate[c.name] || 0) + 1;
  for (const k of Object.keys(castRate)) castRate[k] *= cpm;

  if (opts.onlyAbility) {
    const id = name2id[opts.onlyAbility];
    let procPerMin = 0;
    if (id) {
      const evs = await paginateEvents(code, fight, m.sourceID, eventTable(), id, s, e);
      procPerMin = perHit(evs).procBig / (dur / 60 || 1);
    }
    return { opener: openerSequence(casts), procPerMin, castRate, allCastRate, name2id };
  }

  // You: per-hit detail for the top damage abilities (bounded for API cost).
  const top = abils.slice(0, opts.topN || 4);
  const hits = [];
  for (const a of top) {
    const evs = await paginateEvents(code, fight, m.sourceID, eventTable(), a.guid, s, e);
    if (evs.length) {
      const ph = perHit(evs);
      hits.push({ name: a.name, ...ph, procPerMin: ph.procBig / (dur / 60 || 1) });
    }
  }
  // Per-ability total damage (name -> total), so the cooldown lever can size a
  // missed cooldown by its MEASURED damage-per-cast rather than guessing.
  const dmgTotals = Object.fromEntries(abils.map((a) => [a.name, a.total]));
  return { opener: openerSequence(casts), hits, dur, castRate, allCastRate, dmgTotals, total: m.total, sourceID: m.sourceID, name2id };
}

// Median casts/min per ability across the field's kills (absent in a kill = 0),
// so one peer who weaves an off ability doesn't skew the "field rate".
export function fieldCastRates(peerRates) {
  if (!peerRates.length) return {};
  const names = new Set(peerRates.flatMap((r) => Object.keys(r)));
  const out = {};
  for (const n of names) out[n] = median(peerRates.map((r) => r[n] || 0));
  return out;
}

// Where your ability USAGE diverges from the field: `under` = abilities the field
// presses much more than you (a core spender or damage cooldown you're missing --
// e.g. pressing Raze where the field presses Ravage shows Ravage under + Raze
// over); `over` = abilities you press far more than the field (a wrong button).
// Class-agnostic: the target rates come entirely from the field. `floor` keeps
// out rarely-cast noise; `ratio` requires a real gap (default: 2x).
export function usageDivergence(youRate, fieldRate, { floor = 0.5, ratio = 2 } = {}) {
  const names = new Set([...Object.keys(youRate || {}), ...Object.keys(fieldRate || {})]);
  const under = [], over = [];
  for (const n of names) {
    const y = (youRate || {})[n] || 0, fl = (fieldRate || {})[n] || 0;
    if (fl >= floor && fl >= y * ratio && fl - y >= floor) under.push({ name: n, you: y, field: fl, gap: fl - y });
    if (y >= floor && y >= fl * ratio && y - fl >= floor) over.push({ name: n, you: y, field: fl, gap: y - fl });
  }
  under.sort((a, b) => b.gap - a.gap);
  over.sort((a, b) => b.gap - a.gap);
  return { under, over };
}

// Under-used DAMAGE COOLDOWNS -- the lever usageDivergence structurally MISSES.
// usageDivergence floors at 0.5 casts/min (filler-tuned), but a damage cooldown is
// cast ~0.1-1.0/min, so a player skipping it is invisible there -- and that's
// exactly where a big PLAYSTYLE gap hides (gear/sims only move a few %; the gap at
// matched ilvl is HOW you play). Here we look in the cooldown band and size the
// gap from MEASURED damage: missed casts x your damage-per-cast / your total damage.
// Class-agnostic -- the cooldown set and rates come entirely from you + the field;
// only damage-dealing casts appear (castRate is built from the damage table), so a
// pure buff/summon CD won't show (that needs buff-uptime analysis, not cast counts).
export function cooldownGaps(youRate, fieldRate, dmgTotals, dur, { band = 1.0, minField = 0.1 } = {}) {
  const totalDmg = Object.values(dmgTotals || {}).reduce((a, b) => a + b, 0) || 1;
  const mins = dur ? dur / 60 : 0;
  const out = [];
  for (const [n, fr] of Object.entries(fieldRate || {})) {
    const yr = (youRate || {})[n] || 0;
    if (fr < minField || fr > band) continue;          // only the low-frequency cooldown band
    if (fr <= yr * 1.3 || fr - yr < 0.1) continue;     // you already use it about as much
    const youCasts = yr * mins, fieldCasts = fr * mins;
    // Size from your OWN damage-per-cast (robust to multi-hit; conservative if you
    // use it in worse windows than the field). Needs >=1 of your casts to measure.
    const dpc = youCasts >= 0.5 ? (dmgTotals[n] || 0) / youCasts : null;
    const pct = dpc != null ? Math.round((100 * (fieldCasts - youCasts) * dpc) / totalDmg) : null;
    out.push({ name: n, you: yr, field: fr, youCasts, fieldCasts, pct });
  }
  return out.sort((a, b) => (b.pct || 0) - (a.pct || 0));
}

// COOLDOWN USAGE gaps from ALL casts (keyed by ability id), the layer that catches
// BUFF/PET cooldowns the damage table can't see (Invoke Niuzao, Weapons of Order).
// We can't size a buff/pet CD's damage from cast counts, so this returns the
// measured USAGE gap (you vs field, per kill) -- a "the field presses this cooldown
// more than you" fact to NAME in the playstyle breakdown, not a fabricated %. Only
// the low-frequency band, and only a real gap (field >=1.5x you AND >=1 cast/kill
// more). Class-agnostic; names are resolved by the caller (Wowhead) for just these.
export function castUsageGaps(youRate, fieldRate, dur, { band = 1.5, minField = 0.3 } = {}) {
  const mins = dur ? dur / 60 : 1;
  const out = [];
  for (const [id, fr] of Object.entries(fieldRate || {})) {
    const yr = (youRate || {})[id] || 0;
    if (fr < minField || fr > band) continue;            // cooldown band only (skip fillers)
    if (fr < yr * 1.5 || (fr - yr) * mins < 1) continue; // real gap: >=1 more cast/kill
    out.push({ id, you: yr, field: fr, youPerFight: yr * mins, fieldPerFight: fr * mins, gap: fr - yr });
  }
  return out.sort((a, b) => b.gap - a.gap);
}

// Classify the field's top under-used ability against YOUR talents, so we only
// say "respec" when it's actually a talent you lack. `talent` is the
// { taken, universe } from talentedAbilities (or null when unknown).
//   - "talented-unused": you specced it but never press it -> build/usage problem
//   - "missing-talent":  it's a talent you skipped (peers run it) -> respec
//   - null:              baseline ability you simply aren't pressing (e.g. Shield
//                        of the Righteous), OR not a never-pressed case, OR no
//                        talent data -> handle as an ordinary rotation/priority fix
//                        (NEVER claim a missing talent we can't prove).
export function classifyUnderUse(top, talent) {
  if (!top) return null;
  const neverPress = top.you < 0.2 && top.field >= 1.5;
  if (!neverPress || !talent || !talent.universe) return null;
  if (talent.taken.has(top.name)) return "talented-unused";
  if (talent.universe.has(top.name)) return "missing-talent";
  return null;                              // baseline -> press it, don't respec
}

// --- findings (data the prescription consumes) -------------------------------

// Returns structured rotation findings. The key output is `proc`: a genuine
// empowerment proc (outsized NON-crit hits) you under-use vs the field -- an
// actionable list item. If big hits are merely crits, proc.isReal is false and
// NOTHING is recommended (a "big hit" is usually a crit, not a missed button).
export async function rotationFindings(name, server, region, className, specName, difficulty) {
  // Analyze your most-recent current-gear kill (bestKill -- shared with gear /
  // talents / topparse, so the fetch is cached), not whatever boss you've farmed
  // most. Recent = current play, and a single full kill has plenty of casts.
  const best = await bestKill(name, server, region, difficulty);
  if (!best) return null;
  const boss = best.encounter;
  const you = await analyzeKill(name, best.code, best.fight, specName, className, { topN: 5 });
  if (!you || !you.hits.length) return null;

  const biggest = [...you.hits].sort((a, b) => b.med - a.med)[0];
  const top = [...you.hits].sort((a, b) => b.procBig - a.procBig)[0];
  const isReal = top.procBig >= 2;            // outsized NON-crit cluster = real proc

  // The ilvl-matched field, via the shared core.ilvlPeers (same set overview /
  // timeline / prescribe use, so the fetches dedupe). It feeds the proc rate, the
  // opener, AND the ability-usage comparison.
  const cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName);
  const peers = (await mapLimit(cands, 4, async (r) => {
    try {
      return await analyzeKill(r.name, r.report.code, r.report.fightID, specName, className,
                               { onlyAbility: top.name });
    } catch (e) { return null; }
  })).filter(Boolean).slice(0, 5);
  const fieldProc = (isReal && peers.length) ? median(peers.map((a) => a.procPerMin)) : null;
  const fieldOpener = peers.length ? peers[0].opener : null;
  const fieldRate = fieldCastRates(peers.map((p) => p.castRate || {}));
  const usage = usageDivergence(you.castRate || {}, fieldRate);
  // Under-used damage cooldowns (the band usageDivergence's filler floor misses).
  // Dedupe against usage.under so the same ability isn't double-counted.
  const underNames = new Set(usage.under.map((a) => a.name));
  const cooldowns = (peers.length ? cooldownGaps(you.castRate || {}, fieldRate, you.dmgTotals || {}, you.dur) : [])
    .filter((c) => !underNames.has(c.name));
  // BUFF/PET cooldown usage gaps from ALL casts (the damage table can't see them).
  // Resolve names via Wowhead for just the top few divergent ids (bounded + cached).
  const fieldAllRate = fieldCastRates(peers.map((p) => p.allCastRate || {}));
  let cdUsage = [];
  if (peers.length) {
    const [fs, fe] = await fightWindow(best.code, best.fight);
    const yourTotal = you.total || Object.values(you.dmgTotals || {}).reduce((a, b) => a + b, 0) || 1;
    const gaps = castUsageGaps(you.allCastRate || {}, fieldAllRate, you.dur).slice(0, 5);
    cdUsage = (await mapLimit(gaps, 3, async (g) => {
      const id = Number(g.id);
      // Keep ONLY damage cooldowns YOU actually cast: a targeted DamageDone check
      // drops taunts/defensives/utility (Provoke, Fortifying Brew) and never-cast
      // talents (Empty the Cellar -- the talent lever's job) -- all deal no damage
      // under your source, so "use it on cooldown" can never be a false positive.
      // The same events SIZE the gap: missed casts x your damage-per-cast / total.
      let dmg = [];
      try { dmg = await paginateEvents(best.code, best.fight, you.sourceID, eventTable(), id, fs, fe); } catch (e) { return null; }
      if (!dmg.length) return null;
      let nm = null;
      try { const t = await spellTooltip(id); nm = t && t.name; } catch (e) { return null; }
      if (!nm || underNames.has(nm) || cooldowns.some((c) => c.name === nm)) return null;
      const abilityDmg = dmg.reduce((sm, x) => sm + (x.amount || 0), 0);
      const dpc = g.youPerFight >= 1 ? abilityDmg / g.youPerFight : null;
      const pct = dpc != null ? Math.round((100 * (g.fieldPerFight - g.youPerFight) * dpc) / yourTotal) : null;
      return { name: nm, youPerFight: g.youPerFight, fieldPerFight: g.fieldPerFight, id, pct };
    })).filter(Boolean).slice(0, 3);
  }
  // Measured total damaging-ability casts/min, you vs field -- the direct "are
  // you pressing as often as they are" gap (sizes the press-faster lever).
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const youCpm = sum(you.castRate), fieldCpm = sum(fieldRate);
  const castGap = { you: youCpm, field: fieldCpm, pct: fieldCpm > 0 ? Math.round(((fieldCpm - youCpm) / fieldCpm) * 100) : 0 };
  // Your talented abilities, so the prescription can tell a skipped talent from a
  // baseline ability you simply aren't pressing (don't tell people to "respec"
  // for a baseline button). Best-effort: null if CombatantInfo/Raidbots missing.
  let talent = null;
  try {
    talent = await talentedAbilities(best.code, best.fight, you.sourceID);
  } catch (e) { /* no talent data -> levers treat under-use as a rotation fix */ }
  // Merged ability name -> Wowhead spell id (yours + the field's), so the
  // prescription can link every ability it names (under/over-press, proc, the
  // never-pressed field ability). Yours wins on collision.
  const abilityIds = Object.assign({}, ...peers.map((p) => p.name2id || {}), you.name2id || {});
  return {
    boss: boss.name, hits: you.hits, biggest, opener: you.opener, fieldOpener,
    usage, cooldowns, cdUsage, castGap, fieldPeers: peers.length, talent, abilityIds,
    proc: { name: top.name, isReal, youPerMin: top.procPerMin, fieldPerMin: fieldProc },
  };
}

// --- entry point (prints what rotationFindings computed) ----------------------

export async function run(log, name, server, region, className = "Monk",
                         specName = "Brewmaster", difficulty = 5) {
  const fnd = await rotationFindings(name, server, region, className, specName, difficulty);
  if (!fnd) { log("[error] could not read your casts/damage"); return; }
  log(`Rotation analysis on ${fnd.boss} (your most-killed boss). ` +
      `Spec-agnostic: nothing about ${specName} is hard-coded.`);

  log("");
  log(`=== YOUR ${runIsHealer() ? "BIGGEST HEALS" : "HARDEST-HITTING ABILITIES"} (per cast) ===`);
  for (const h of [...fnd.hits].sort((a, b) => b.med - a.med))
    log(`  ${h.name.padEnd(20)} median ${Math.round(h.med).toLocaleString().padStart(8)}  ` +
        `max ${Math.round(h.max).toLocaleString().padStart(8)}  (${Math.round(h.critPct)}% crit, ` +
        `${h.procBig} non-crit big hits)`);
  log(`  -> biggest single-hit ability: ${fnd.biggest.name}`);

  log("");
  if (!fnd.proc.isReal) {
    log("=== BIG HITS ARE CRIT-DRIVEN, NOT A PROC ===");
    log("  Your outsized hits are crits, not a missed empowerment button. More big");
    log("  hits = more crit + raid damage buffs (comp), not a rotation change.");
  } else {
    const p = fnd.proc;
    log(`=== EMPOWERMENT PROC (${p.name}, non-crit big hits) ===`);
    log(`  proc hits/min:  you ${p.youPerMin.toFixed(1)}   peers ${p.fieldPerMin == null ? "?" : p.fieldPerMin.toFixed(1)}`);
    if (p.fieldPerMin != null)
      log(p.youPerMin >= p.fieldPerMin - 0.4
        ? "  -> About the same as peers. Good."
        : "  -> Fewer than peers -- you're under-generating/using the proc.");
  }

  log("");
  log("=== OPENER ===");
  log(`  your opener:  ${fnd.opener.join(" > ")}`);
  if (fnd.fieldOpener) log(`  peers' opener: ${fnd.fieldOpener.join(" > ")}`);

  const u = fnd.usage || { under: [], over: [] };
  if (u.under.length || u.over.length) {
    log("");
    log(`=== ABILITY USAGE vs PEERS (casts/min, ${fnd.fieldPeers} peers) ===`);
    for (const a of u.under.slice(0, 4))
      log(`  UNDER-USE  ${a.name.padEnd(20)} you ${a.you.toFixed(1)}/min  peers ${a.field.toFixed(1)}/min  <-- press it more`);
    for (const a of u.over.slice(0, 4))
      log(`  OVER-USE   ${a.name.padEnd(20)} you ${a.you.toFixed(1)}/min  peers ${a.field.toFixed(1)}/min  <-- peers barely press this`);
    if (u.under.length) log("  -> Shift presses toward what peers actually cast.");
  }
}

// Findings for prescribe.js (rotation domain): the actionable levers from
// rotationFindings() data as the shared { dim, impact, label, text } currency.
// Only a GENUINE under-used proc is actionable -- crit-driven big hits are
// deliberately NOT recommended (a big hit is usually just a crit). Pure.
export function rotationLevers(rot) {
  const out = [];
  const ids = (rot && rot.abilityIds) || {};
  const link = (n) => wowheadSpell(ids[n], n);   // ability name -> Wowhead link when we have the id
  // Biggest rotation lever: where your ability USAGE diverges from the field.
  // Pressing the wrong button (over-use one, never press the field's) or skipping
  // a cooldown is usually the largest gap for an underperformer -- sorts above
  // gear. Impact is an estimate (we can't sim it), sized by wrong-button vs under-use.
  const u = rot && rot.usage;
  if (u && u.under.length) {
    const top = u.under[0];
    const overTop = u.over[0];
    // Never casting an ability the field leans on USED to be reported as "missing
    // the talent -- respec". That over-reached on baseline buttons (a Prot Paladin
    // told to respec for Shield of the Righteous). Now we check YOUR talents:
    // only call it a missing talent if it's actually a talent you skipped; if you
    // specced it but don't press it, it's a build/usage problem; a baseline button
    // you skip falls through to the ordinary "press it more" rotation fix.
    const cls = classifyUnderUse(top, rot && rot.talent);
    const onGlobals = overTop ? ` Right now you spend those globals on ${link(overTop.name)}.` : "";
    if (cls === "missing-talent") {
      out.push(finding("Rotation", DPS(5, 10),
        `TALENTS/BUILD: you never press ${link(top.name)}, and you haven't talented it while the field casts it ` +
        `${f(top.field, 1)}/min -- respec to the field's build (the one with ${link(top.name)}); your rotation ` +
        `can't include it until you do.${onGlobals}`));
    } else if (cls === "talented-unused") {
      out.push(finding("Rotation", DPS(5, 10),
        `TALENTS/BUILD: you've talented ${link(top.name)} but never press it, while the field casts it ` +
        `${f(top.field, 1)}/min -- a wasted talent. Work it into your rotation, or respec the point into ` +
        `something you'll actually use.${onGlobals}`));
    } else {
      const under = u.under.slice(0, 2).map((a) => `${link(a.name)} (peers ${f(a.field, 1)}/min vs your ${f(a.you, 1)})`);
      const wrongButton = u.over.length > 0;
      const over = wrongButton
        ? `; you over-press ${u.over.slice(0, 1).map((a) => `${link(a.name)} (your ${f(a.you, 1)}/min vs peers ${f(a.field, 1)})`).join("")}`
        : "";
      out.push(finding("Rotation", wrongButton ? DPS(5, 10) : DPS(3, 6),
        `ROTATION: press ${under.join(" and ")} more${over} -- match your peers' ability priority ` +
        `(verify in a log/sim).`));
    }
  }
  // Under-used DAMAGE COOLDOWNS -- a measured PLAYSTYLE lever (the kind that
  // explains a big remainder; gear/sims don't). Sized from real damage-per-cast.
  // Two sources: cooldowns (the truncated damage table) and cdUsage (cast events,
  // which catch cooldowns beyond the top-5 the damage table shows). Dedupe by name.
  const seenCd = new Set();
  for (const cd of ((rot && rot.cooldowns) || []).slice(0, 2)) {
    if (cd.pct && cd.pct >= 1) {
      seenCd.add(cd.name);
      out.push(finding("Rotation", DPS(cd.pct),
        `COOLDOWN: you cast ${link(cd.name)} ${cd.youCasts.toFixed(1)}x this fight (${f(cd.you, 1)}/min) vs the field's ` +
        `${cd.fieldCasts.toFixed(1)}x (${f(cd.field, 1)}/min) -- ~${cd.pct}% of your damage. Use it on cooldown ` +
        `(or line it up with your burst); it's a button you're skipping, not gear.`));
    }
  }
  for (const cd of ((rot && rot.cdUsage) || [])) {
    if (cd.pct && cd.pct >= 1 && !seenCd.has(cd.name)) {
      seenCd.add(cd.name);
      out.push(finding("Rotation", DPS(cd.pct),
        `COOLDOWN: you cast ${wowheadSpell(cd.id, cd.name)} ${cd.youPerFight.toFixed(0)}x/kill vs the field's ` +
        `${cd.fieldPerFight.toFixed(0)}x -- ~${cd.pct}% of your damage. Use it on cooldown; it's a button you're ` +
        `skipping, not gear.`));
    }
  }
  if (rot && rot.proc.isReal && rot.proc.fieldPerMin != null &&
      rot.proc.youPerMin < rot.proc.fieldPerMin - 0.4) {
    out.push(finding("Rotation", DPS(1, 2), `PROC: you land ${f(rot.proc.youPerMin, 1)} ${link(rot.proc.name)} ` +
      `procs/min vs your peers' ${f(rot.proc.fieldPerMin, 1)} -- generate/use it more.`));
  }
  return out;
}
