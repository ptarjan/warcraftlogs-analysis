// Rotation analysis -- CLASS-AGNOSTIC. Works for any spec because it hard-codes
// no ability names or priorities (the bug before: assuming Tiger Palm was a
// filler when an empowered Tiger Palm is actually the biggest hit). Everything
// is derived from the data and compared to the field:
//   - which of YOUR abilities hits hardest (per-hit), for any class
//   - "empowered" hits: abilities with a high cluster of outsized hits (procs);
//     how often you land them vs the field
//   - your opener sequence vs the field's
import { gql } from "./wcl.js";
import { characterZone, characterEncounter, playerMetrics, topRankings, median } from "./core.js";

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

// --- data layer --------------------------------------------------------------

async function fightWindow(code, fight) {
  const d = await gql(`query{reportData{report(code:"${code}"){fights(fightIDs:${fight}){startTime endTime}}}}`);
  const f = d.reportData.report.fights[0];
  return [f.startTime, f.endTime];
}

// One player's damage abilities (guid/name/total), highest total first.
async function damageAbilities(code, fight, name, className) {
  const d = await gql(`query{reportData{report(code:"${code}"){table(fightIDs:${fight},dataType:DamageDone,sourceClass:"${className}")}}}`);
  const e = (d.reportData.report.table.data.entries || []).find((x) => x.name === name)
    || (d.reportData.report.table.data.entries || [])[0];
  if (!e) return [];
  return (e.abilities || []).filter((a) => a.guid != null && a.total > 0)
    .sort((a, b) => b.total - a.total);
}

async function pageEvents(code, fight, sourceId, dataType, abilityId, s, e) {
  const out = [];
  let cursor = s;
  const ab = abilityId != null ? `,abilityID:${abilityId}` : "";
  while (true) {
    const d = await gql(`query{reportData{report(code:"${code}"){events(fightIDs:${fight},sourceID:${sourceId},dataType:${dataType}${ab},limit:10000,startTime:${cursor},endTime:${e}){data nextPageTimestamp}}}}`);
    const ev = d.reportData.report.events;
    out.push(...ev.data);
    if (!ev.nextPageTimestamp) break;
    cursor = ev.nextPageTimestamp;
  }
  return out;
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
  const casts = (await pageEvents(code, fight, m.sourceID, "Casts", null, s, e))
    .filter((x) => !x.fake && id2name[x.abilityGameID])
    .map((x) => ({ t: x.timestamp - s, name: id2name[x.abilityGameID] }))
    .sort((a, b) => a.t - b.t);
  if (casts.length < 5) return null;

  if (opts.onlyAbility) {
    const id = name2id[opts.onlyAbility];
    let procPerMin = 0;
    if (id) {
      const evs = await pageEvents(code, fight, m.sourceID, "DamageDone", id, s, e);
      procPerMin = perHit(evs).procBig / (dur / 60 || 1);
    }
    return { opener: openerSequence(casts), procPerMin };
  }

  // You: per-hit detail for the top damage abilities (bounded for API cost).
  const top = abils.slice(0, opts.topN || 4);
  const hits = [];
  for (const a of top) {
    const evs = await pageEvents(code, fight, m.sourceID, "DamageDone", a.guid, s, e);
    if (evs.length) {
      const ph = perHit(evs);
      hits.push({ name: a.name, ...ph, procPerMin: ph.procBig / (dur / 60 || 1) });
    }
  }
  return { opener: openerSequence(casts), hits, dur };
}

// --- findings (data the prescription consumes) -------------------------------

// Returns structured rotation findings. The key output is `proc`: a genuine
// empowerment proc (outsized NON-crit hits) you under-use vs the field -- an
// actionable list item. If big hits are merely crits, proc.isReal is false and
// NOTHING is recommended (a "big hit" is usually a crit, not a missed button).
export async function rotationFindings(name, server, region, className, specName, difficulty) {
  const c = await characterZone(name, server, region, difficulty);
  const killed = (c.zoneRankings.rankings || [])
    .filter((r) => r.totalKills > 0 && r.rankPercent != null)
    .sort((a, b) => b.totalKills - a.totalKills);
  if (!killed.length) return null;
  const boss = killed[0].encounter;
  const er = await characterEncounter(name, server, region, boss.id, difficulty);
  const you = await analyzeKill(name, er.ranks[0].report.code, er.ranks[0].report.fightID,
                                specName, className, { topN: 5 });
  if (!you || !you.hits.length) return null;

  const biggest = [...you.hits].sort((a, b) => b.med - a.med)[0];
  const top = [...you.hits].sort((a, b) => b.procBig - a.procBig)[0];
  const isReal = top.procBig >= 2;            // outsized NON-crit cluster = real proc

  let fieldProc = null, fieldOpener = null;
  if (isReal) {
    const peers = [];
    const myIlvl = (er.ranks[0] || {}).bracketData || 0;
    outer:
    for (let page = 1; page <= 4; page++) {
      for (const r of await topRankings(boss.id, difficulty, className, specName, page)) {
        if (peers.length >= 4) break outer;
        if (Math.abs((r.bracketData || 0) - myIlvl) > 4) continue;
        try {
          const a = await analyzeKill(r.name, r.report.code, r.report.fightID, specName, className,
                                      { onlyAbility: top.name });
          if (a) peers.push(a);
        } catch (e) { /* skip */ }
      }
    }
    fieldProc = peers.length ? median(peers.map((a) => a.procPerMin)) : null;
    fieldOpener = peers.length ? peers[0].opener : null;
  }
  return {
    boss: boss.name, hits: you.hits, biggest, opener: you.opener, fieldOpener,
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
  log("=== YOUR HARDEST-HITTING ABILITIES (per hit) ===");
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
    log(`  proc hits/min:  you ${p.youPerMin.toFixed(1)}   field ${p.fieldPerMin == null ? "?" : p.fieldPerMin.toFixed(1)}`);
    if (p.fieldPerMin != null)
      log(p.youPerMin >= p.fieldPerMin - 0.4
        ? "  -> About the same as the field. Good."
        : "  -> Fewer than the field -- you're under-generating/using the proc.");
  }

  log("");
  log("=== OPENER ===");
  log(`  your opener:  ${fnd.opener.join(" > ")}`);
  if (fnd.fieldOpener) log(`  field opener: ${fnd.fieldOpener.join(" > ")}`);
}
