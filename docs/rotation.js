// Rotation analysis: your OPENER and PRIORITY ("wrong button") quality, vs the
// field. Distinguishes "occasional gaps" (timing, see diagnose.js) from "wrong
// buttons" (casting a filler while a higher-priority ability was off cooldown),
// and shows how your opening sequence + cooldown usage compares to top players.
import { gql } from "./wcl.js";
import { characterZone, characterEncounter, playerMetrics, topRankings, median } from "./core.js";

// Brewmaster damage priority (highest first). Fillers are the lowest-value
// presses that should yield to anything above them when it's available.
const FILLERS = new Set(["Tiger Palm"]);
const WATCH = ["Keg Smash"]; // clearest cooldown-gated high-priority button
const OPENER_CDS = ["Weapons of Order", "Invoke Niuzao, the Black Ox",
                    "Exploding Keg", "Celestial Brew", "Rising Sun Kick"];

// --- pure, unit-tested helpers ----------------------------------------------

// Effective cooldown ~ the floor of inter-cast gaps (10th percentile is robust
// against the odd early recast from haste/resets).
export function effectiveCooldown(ts) {
  if (ts.length < 2) return Infinity;
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length * 0.1)];
}

// Count filler casts made while a higher-priority watched ability was available
// (off cooldown). casts: [{t, name}] sorted by t. watch: [{name, cd}].
export function priorityMisses(casts, fillers, watch) {
  const last = {};
  let misses = 0, fillers_n = 0;
  for (const c of casts) {
    if (fillers.has(c.name)) {
      fillers_n++;
      for (const w of watch) {
        const lt = last[w.name];
        if (lt === undefined || c.t - lt >= w.cd * 1.05) { misses++; break; }
      }
    }
    last[c.name] = c.t;
  }
  return { misses, fillers: fillers_n };
}

// First n GCD-casts within `windowMs` of the first cast.
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

// Ability guid -> name. Filtering the Casts table by sourceID returns empty
// abilities, so query by class and merge all entries (ability ids are global).
async function nameMap(code, fight, className) {
  const d = await gql(`query{reportData{report(code:"${code}"){table(fightIDs:${fight},dataType:Casts,sourceClass:"${className}")}}}`);
  const m = {};
  for (const e of d.reportData.report.table.data.entries || [])
    for (const a of e.abilities || []) if (a.guid != null) m[a.guid] = a.name;
  return m;
}

async function castEvents(code, fight, sourceId, start, end) {
  const out = [];
  let cursor = start;
  while (true) {
    const st = cursor != null ? `, startTime:${cursor}` : "";
    const d = await gql(`query{reportData{report(code:"${code}"){events(fightIDs:${fight},sourceID:${sourceId},dataType:Casts,limit:10000${st}, endTime:${end}){data nextPageTimestamp}}}}`);
    const ev = d.reportData.report.events;
    out.push(...ev.data);
    if (!ev.nextPageTimestamp) break;
    cursor = ev.nextPageTimestamp;
  }
  return out;
}

// Build the {t, name} cast list for one actor on one fight (GCD casts only).
async function timeline(code, fight, sourceId, className) {
  const [s, e] = await fightWindow(code, fight);
  const names = await nameMap(code, fight, className);
  const raw = (await castEvents(code, fight, sourceId, s, e))
    .filter((x) => !x.fake && names[x.abilityGameID])
    .map((x) => ({ t: x.timestamp - s, name: names[x.abilityGameID] }))
    .sort((a, b) => a.t - b.t);
  return { casts: raw, dur: (e - s) / 1000 };
}

// Analyze one fight: opener sequence, opener cooldowns used, priority misses/min.
function analyzeFight(tl) {
  const byName = {};
  for (const c of tl.casts) (byName[c.name] ||= []).push(c.t);
  const watch = WATCH.map((n) => ({ name: n, cd: effectiveCooldown(byName[n] || []) }))
    .filter((w) => Number.isFinite(w.cd));
  const { misses, fillers } = priorityMisses(tl.casts, FILLERS, watch);
  const openCds = OPENER_CDS.filter((n) => (byName[n] || []).some((t) => t <= 20000));
  return {
    opener: openerSequence(tl.casts),
    openCds,
    missesPerMin: tl.dur ? misses / (tl.dur / 60) : 0,
    missPct: fillers ? (100 * misses) / fillers : 0,
  };
}

async function analyzeKill(name, code, fight, specName, className) {
  const m = await playerMetrics(code, fight, name, specName, className);
  if (!m) return null;
  const tl = await timeline(code, fight, m.sourceID, className);
  if (tl.casts.length < 5) return null;
  return analyzeFight(tl);
}

// --- entry point -------------------------------------------------------------

export async function run(log, name, server, region, className = "Monk",
                         specName = "Brewmaster", difficulty = 5) {
  const c = await characterZone(name, server, region, difficulty);
  const killed = (c.zoneRankings.rankings || [])
    .filter((r) => r.totalKills > 0 && r.rankPercent != null)
    .sort((a, b) => b.totalKills - a.totalKills);
  if (!killed.length) { log("[error] no kills found"); return; }
  const boss = killed[0].encounter; // most-killed = most data
  log(`Rotation analysis on ${boss.name} (your most-killed boss).`);

  // Your kills (up to 3).
  const er = await characterEncounter(name, server, region, boss.id, difficulty);
  const yours = [];
  for (const rk of (er.ranks || []).slice(0, 3)) {
    const a = await analyzeKill(name, rk.report.code, rk.report.fightID, specName, className);
    if (a) yours.push(a);
  }
  if (!yours.length) { log("[error] could not read your casts"); return; }

  // Peers (up to 4, similar ilvl).
  const peers = [];
  const myIlvl = (er.ranks[0] || {}).bracketData || 0;
  outer:
  for (let page = 1; page <= 4; page++) {
    for (const r of await topRankings(boss.id, difficulty, className, specName, page)) {
      if (peers.length >= 4) break outer;
      if (Math.abs((r.bracketData || 0) - myIlvl) > 4) continue;
      try {
        const a = await analyzeKill(r.name, r.report.code, r.report.fightID, specName, className);
        if (a) peers.push(a);
      } catch (e) { /* private/skip */ }
    }
  }

  const yMiss = median(yours.map((a) => a.missesPerMin));
  const pMiss = peers.length ? median(peers.map((a) => a.missesPerMin)) : NaN;
  log("");
  log("=== WRONG BUTTONS (filler cast while Keg Smash was available) ===");
  log(`  you:   ${yMiss.toFixed(1)} priority-misses/min  (${median(yours.map((a) => a.missPct)).toFixed(0)}% of your fillers)`);
  log(`  field: ${pMiss.toFixed(1)} /min`);
  log(yMiss <= pMiss + 0.5
    ? "  -> Your button PRIORITY is fine -- not a wrong-button problem."
    : "  -> You press fillers while Keg Smash is up more than the field -- a real priority leak.");

  log("");
  log("=== OPENER ===");
  log(`  your opener:  ${yours[0].opener.join(" > ")}`);
  if (peers.length) log(`  field opener: ${peers[0].opener.join(" > ")}`);
  const yCds = yours[0].openCds, pCds = peers.length ? peers[0].openCds : [];
  log(`  cooldowns you used in first 20s:  ${yCds.join(", ") || "(none)"}`);
  if (peers.length) log(`  cooldowns field used in first 20s: ${pCds.join(", ") || "(none)"}`);
  const missingCds = pCds.filter((x) => !yCds.includes(x));
  if (missingCds.length)
    log(`  -> field opens with cooldowns you don't: ${missingCds.join(", ")}`);
}
