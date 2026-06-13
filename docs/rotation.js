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

function perHit(amounts) {
  const s = [...amounts].sort((a, b) => a - b);
  return { count: s.length, med: s.length ? s[Math.floor(s.length / 2)] : 0,
           max: s.length ? s[s.length - 1] : 0, emp: empoweredCount(amounts) };
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
    let emp = 0;
    if (id) {
      const amts = (await pageEvents(code, fight, m.sourceID, "DamageDone", id, s, e)).map((x) => x.amount || 0);
      emp = empoweredCount(amts) / (dur / 60 || 1);
    }
    return { opener: openerSequence(casts), empPerMin: emp };
  }

  // You: per-hit detail for the top damage abilities (bounded for API cost).
  const top = abils.slice(0, opts.topN || 4);
  const hits = [];
  for (const a of top) {
    const amts = (await pageEvents(code, fight, m.sourceID, "DamageDone", a.guid, s, e)).map((x) => x.amount || 0);
    if (amts.length) hits.push({ name: a.name, ...perHit(amts), perMin: empoweredCount(amts) / (dur / 60 || 1) });
  }
  return { opener: openerSequence(casts), hits, dur };
}

// --- entry point -------------------------------------------------------------

export async function run(log, name, server, region, className = "Monk",
                         specName = "Brewmaster", difficulty = 5) {
  const c = await characterZone(name, server, region, difficulty);
  const killed = (c.zoneRankings.rankings || [])
    .filter((r) => r.totalKills > 0 && r.rankPercent != null)
    .sort((a, b) => b.totalKills - a.totalKills);
  if (!killed.length) { log("[error] no kills found"); return; }
  const boss = killed[0].encounter;
  log(`Rotation analysis on ${boss.name} (your most-killed boss). ` +
      `Spec-agnostic: nothing about ${specName} is hard-coded.`);

  const er = await characterEncounter(name, server, region, boss.id, difficulty);
  const you = await analyzeKill(name, er.ranks[0].report.code, er.ranks[0].report.fightID,
                                specName, className, { topN: 5 });
  if (!you || !you.hits.length) { log("[error] could not read your casts/damage"); return; }

  const biggest = [...you.hits].sort((a, b) => b.med - a.med)[0];      // hardest per hit
  const empAbil = [...you.hits].sort((a, b) => b.emp - a.emp)[0];      // most "empowered" -> the proc

  log("");
  log("=== YOUR HARDEST-HITTING ABILITIES (per hit) ===");
  for (const h of [...you.hits].sort((a, b) => b.med - a.med))
    log(`  ${h.name.padEnd(20)} median ${Math.round(h.med).toLocaleString().padStart(8)}  ` +
        `max ${Math.round(h.max).toLocaleString().padStart(8)}  (${h.emp} empowered hits)`);
  log(`  -> biggest single-hit ability: ${biggest.name}`);

  // Compare the empowerment proc to the field, by the SAME ability name.
  const peers = [];
  const myIlvl = (er.ranks[0] || {}).bracketData || 0;
  outer:
  for (let page = 1; page <= 4; page++) {
    for (const r of await topRankings(boss.id, difficulty, className, specName, page)) {
      if (peers.length >= 4) break outer;
      if (Math.abs((r.bracketData || 0) - myIlvl) > 4) continue;
      try {
        const a = await analyzeKill(r.name, r.report.code, r.report.fightID, specName, className,
                                    { onlyAbility: empAbil.name });
        if (a) peers.push(a);
      } catch (e) { /* private/skip */ }
    }
  }
  const pEmp = peers.length ? median(peers.map((a) => a.empPerMin)) : NaN;
  log("");
  log(`=== EMPOWERED PROC (${empAbil.name} -- your most-empowered ability) ===`);
  log(`  empowered ${empAbil.name}/min:  you ${empAbil.perMin.toFixed(1)}   ` +
      `field ${Number.isNaN(pEmp) ? "?" : pEmp.toFixed(1)}`);
  if (!Number.isNaN(pEmp))
    log(empAbil.perMin >= pEmp - 0.4
      ? "  -> You're landing empowered procs about as often as the field. Good."
      : "  -> Fewer empowered procs than the field -- you're under-generating/using it.");

  log("");
  log("=== OPENER ===");
  log(`  your opener:  ${you.opener.join(" > ")}`);
  if (peers.length) log(`  field opener: ${peers[0].opener.join(" > ")}`);
}
