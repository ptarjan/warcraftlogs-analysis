// @ts-check
// Raid PROGRESSION analyzer: a separate flow from the single-character tool. Given
// a report (a night of pulls) and a boss, figure out what's BLOCKING the kill and
// emit a FEW actionable, named changes -- the group's "what to change to win" list.
//
// Unlike prescribe.js (one character's DPS gap vs peers), this is driven by WIPES:
// where pulls keep ending (the "wall"), who dies and to what, and whether the raid
// is short on damage to beat the gate. It backtests over every pull in the report
// to surface the trend toward a kill, and (multi-night) stitches prior nights.
//
// Budget discipline (a night = 30-60 pulls): we NEVER fetch tables per pull. ONE
// reportFights (all metadata), ONE batched reportDeaths over the analyzed pulls,
// ONE reportRoster, and reportCore on only the ~2 most informative pulls (deepest
// + most recent) for the DPS check. ~6 report requests for a whole night.
import { spellTooltip } from "./wcl.js";
import {
  reportFights, reportDeaths, reportRoster, reportCore, encounterKillTimes,
  median, f, finding, mapLimit, DIFFICULTY,
} from "./core.js";
import { wowheadSpell, wclReport } from "./links.js";

// --- tunables (class/encounter-agnostic; no hard-coded names or enrage timers) -- //
const ANALYZE_WIPES = 12;     // most-recent wipes to deep-analyze (current strat/roster)
const DEATH_WINDOW_MS = 15000; // deaths within this of a pull's end = the cascade that wiped it
const RECUR_MIN = 2;          // never call out something seen in only ONE pull (noise)
const MAX_FINDINGS = 5;       // a FEW actionable items, biggest blocker first
const LAGGARD_FRAC = 0.6;     // a "low contributor" does < this fraction of the raid median

// Progression-specific Score constructors (mirror core's DPS()/COMP(): impact and
// label forged together so the sort key can't drift from the shown text). This
// flow renders its OWN sorted list, so impact need not be DPS% -- it's a blocker
// severity, internally consistent: roughly "how much is this stopping the kill".
const BLOCK = (pctPulls) => ({ impact: Math.round(pctPulls), label: `ends ~${Math.round(pctPulls)}% of pulls` });
const GATE = (pctShort) => ({ impact: Math.round(pctShort), label: `~${Math.round(pctShort)}% DPS short` });
const NOTE = { impact: 0, label: "info" };

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const secs = (ms) => ms / 1000;

// The pulls of ONE boss in a report: filter to real encounters (encounterID>0),
// and when no boss is named, pick the one the group pulled MOST (the progression
// target that night). Returns { encounterID, name, pulls } or null.
export function pickEncounter(fights, encounterId = null) {
  const boss = (fights || []).filter((x) => x.encounterID && x.encounterID > 0);
  if (!boss.length) return null;
  if (encounterId) {
    const pulls = boss.filter((x) => x.encounterID === encounterId);
    return pulls.length ? { encounterID: encounterId, name: pulls[0].name, pulls } : null;
  }
  const byEnc = new Map();
  for (const x of boss) { const a = byEnc.get(x.encounterID) || []; a.push(x); byEnc.set(x.encounterID, a); }
  let best = null;
  for (const [eid, arr] of byEnc) if (!best || arr.length > best.pulls.length) best = { encounterID: eid, name: arr[0].name, pulls: arr };
  return best;
}

// Every encounter pulled in a report, for a picker (most-pulled first).
export function encountersIn(fights) {
  const byEnc = new Map();
  for (const x of (fights || [])) {
    if (!(x.encounterID > 0)) continue;
    const e = byEnc.get(x.encounterID) || { encounterID: x.encounterID, name: x.name, pulls: 0, kills: 0, difficulty: x.difficulty };
    e.pulls++; if (x.kill) e.kills++; byEnc.set(x.encounterID, e);
  }
  return [...byEnc.values()].sort((a, b) => b.pulls - a.pulls);
}

// Resolve a death event's victim name+class and the killing ability id, via the
// report roster (actor id -> {name, subType=class}).
function victimOf(ev, roster) {
  const a = roster.get(ev.targetID) || {};
  return { name: a.name || `#${ev.targetID}`, cls: a.subType || "", id: ev.targetID };
}
const killerAbility = (ev) => ev.killingAbilityGameID || ev.abilityGameID || 0;

// Name a set of spell ids -> { id: name } (one tooltip each, only the few we'll
// surface). Best-effort: a missing tooltip just leaves the id unlinked.
async function nameSpells(ids) {
  const out = {};
  await mapLimit([...ids], 6, async (id) => {
    try { const t = await spellTooltip(id); out[id] = (t && t.name) || `spell ${id}`; }
    catch { out[id] = `spell ${id}`; }
  });
  return out;
}

// ----------------------------------------------------------------------------- //
// Core analysis: one report, one boss. Pure compute -> a structured result that
// run() formats. Fetches are bounded (see budget note at top). `fresh` polls a
// live report's fight list without serving a stale cache.
// ----------------------------------------------------------------------------- //
export async function progressionFindings(code, { encounterId = null, fresh = false } = {}) {
  // The fight LIST is primed by the caller (one fresh fetch in live mode); read it
  // from cache here. `fresh` governs the DEATHS query so a just-ended pull's deaths
  // refresh on a live update, while a finished report stays fully cached.
  const fights = await reportFights(code, { fresh: false });
  const enc = pickEncounter(fights, encounterId);
  if (!enc) return null;
  const pulls = [...enc.pulls].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const kills = pulls.filter((p) => p.kill);
  const wipes = pulls.filter((p) => !p.kill);
  const difficulty = pulls[0].difficulty;

  // Progress = boss health REMAINING at pull end (fightPercentage; 0 = kill, lower
  // = closer). Best = deepest pull. The "wall" = where recent wipes keep ending.
  const remaining = (p) => (p.fightPercentage != null ? p.fightPercentage : (p.bossPercentage != null ? p.bossPercentage : 100));
  const deepest = wipes.length ? wipes.reduce((a, b) => (remaining(b) < remaining(a) ? b : a)) : null;
  const recentWipes = wipes.slice(-ANALYZE_WIPES);
  const phases = new Set(pulls.map((p) => p.lastPhase).filter((x) => x != null));
  const multiPhase = phases.size > 1 || Math.max(0, ...pulls.map((p) => p.lastPhase || 0)) > 1;

  const result = {
    code, encounterID: enc.encounterID, boss: enc.name, difficulty,
    nPulls: pulls.length, nWipes: wipes.length, nKills: kills.length,
    killed: kills.length > 0, lastKill: kills.length ? kills[kills.length - 1] : null,
    bestRemaining: deepest ? remaining(deepest) : 0, deepest, multiPhase,
    pulls, recentWipes, findings: [], notes: [],
  };

  // The wall: modal (lastPhase, 5%-bucket) among recent wipes.
  if (recentWipes.length) {
    const tally = new Map();
    for (const p of recentWipes) {
      const k = `${p.lastPhase || 0}|${Math.round(remaining(p) / 5) * 5}`;
      const e = tally.get(k) || { phase: p.lastPhase || 0, rem: Math.round(remaining(p) / 5) * 5, n: 0 };
      e.n++; tally.set(k, e);
    }
    result.wall = [...tally.values()].sort((a, b) => b.n - a.n)[0];
  }

  // Already killed and not still wiping after the last kill -> say so; the kill is
  // the win, there's no blocker left to prescribe.
  if (result.killed) {
    const lastKillT = kills[kills.length - 1].startTime || 0;
    const wipedAfterKill = wipes.some((w) => (w.startTime || 0) > lastKillT);
    if (!wipedAfterKill) {
      result.findings.push(finding("Info", NOTE,
        `${result.boss} is **down** — killed after ${pulls.length} pulls. On farm now; switch to the per-character DPS analysis to push parses.`));
      return result;
    }
  }

  // ---- Deaths across the analyzed wipes (ONE batched request) ----------------- //
  const analyzed = recentWipes.length ? recentWipes : wipes;
  let roster = new Map();
  let deaths = [];
  try {
    [deaths, roster] = await Promise.all([
      reportDeaths(code, analyzed.map((p) => p.id), { fresh }),
      reportRoster(code),
    ]);
  } catch { /* best-effort: deaths/roster unavailable -> skip survival lever */ }
  const endById = new Map(analyzed.map((p) => [p.id, p.endTime]));
  const nA = analyzed.length;

  // CAUSE vs CONSEQUENCE. When a pull wipes, the whole raid dies in the final
  // seconds (enrage / reset / a raid-wide finisher) — so "everyone died 12/12" is
  // the WIPE, not a per-player problem, and blaming those players is noise. Only an
  // EARLY death (well before the pull ended) is a leading cause worth naming: losing
  // a player before the wipe is what tips the pull. The tail cluster is the wall,
  // handled by the DPS check / wall note below. Class/encounter-agnostic.
  const isEarly = (ev) => (endById.get(ev.fight) - ev.timestamp) > DEATH_WINDOW_MS;

  const byAbility = new Map();   // id -> { pulls:Set, victims:Map(name->count) }  (early only)
  const byPlayer = new Map();    // name -> { pulls:Set, cls }                     (early only)
  for (const ev of deaths) {
    const fid = ev.fight;
    if (fid == null || !endById.has(fid) || !isEarly(ev)) continue;   // skip wipe-tail deaths
    const v = victimOf(ev, roster);
    if (v.cls && /^(NPC|Pet|Boss)$/i.test(v.cls)) continue;
    const aid = killerAbility(ev);
    if (aid) {
      const a = byAbility.get(aid) || { pulls: new Set(), victims: new Map() };
      a.pulls.add(fid); a.victims.set(v.name, (a.victims.get(v.name) || 0) + 1); byAbility.set(aid, a);
    }
    const p = byPlayer.get(v.name) || { pulls: new Set(), cls: v.cls };
    p.pulls.add(fid); byPlayer.set(v.name, p);
  }

  // Name the few abilities/players we'll actually surface (recurrence-gated).
  const topAbilities = [...byAbility.entries()].filter(([, a]) => a.pulls.size >= RECUR_MIN)
    .sort((a, b) => b[1].pulls.size - a[1].pulls.size).slice(0, 2);
  const repeatPlayers = [...byPlayer.entries()].filter(([, p]) => p.pulls.size >= Math.max(RECUR_MIN, Math.ceil(nA / 2)))
    .sort((a, b) => b[1].pulls.size - a[1].pulls.size).slice(0, 4);
  const spellNames = await nameSpells(new Set(topAbilities.map(([id]) => id)));
  result.hasEarlyCause = !!(topAbilities.length || repeatPlayers.length);

  // ---- Survival / mechanic findings (data-derived, named) --------------------- //
  for (const [aid, a] of topAbilities) {
    const victims = [...a.victims.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([n]) => n);
    const link = wowheadSpell(aid, spellNames[aid] || `spell ${aid}`);
    result.findings.push(finding("Mechanic", BLOCK(pct(a.pulls.size, nA)),
      `**Avoid ${link}** — it kills someone EARLY (before the wipe) in ${a.pulls.size} of the last ${nA} pulls` +
      (victims.length ? ` (most-hit: ${victims.join(", ")})` : "") +
      `. An early death here is what tips the pull — assign or handle this mechanic.`));
  }
  if (repeatPlayers.length) {
    const who = repeatPlayers.map(([n, p]) => `${n}${p.cls ? ` (${p.cls})` : ""} ${p.pulls.size}/${nA}`).join(", ");
    result.findings.push(finding("Survival", BLOCK(pct(repeatPlayers[0][1].pulls.size, nA)),
      `**Early deaths** are tipping pulls: ${who} die well before the wipe (not in the final cascade). ` +
      `Losing a player early snowballs the pull — a survival/positioning fix or assignment swap here beats any DPS gain.`));
  }

  // ---- DPS / soft-enrage check (best-effort, only the deepest+recent pulls) ---- //
  try { await dpsCheck(result, analyzed); } catch { /* leave it out */ }

  // ---- Roster / "what changed" backtest --------------------------------------- //
  try { rosterDelta(result, pulls, roster); } catch { /* optional */ }

  // Sort biggest blocker first; cap to a FEW. INFO notes (impact 0) sink to the end.
  result.findings.sort((a, b) => b.impact - a.impact);
  result.findings = result.findings.slice(0, MAX_FINDINGS);
  if (!result.findings.length) {
    // Nothing recurring early AND no DPS gap we could size -> the wipes are the raid
    // going down TOGETHER at the wall, not individual mistakes. Say that plainly
    // instead of inventing per-player blame.
    const wallTxt = result.wall ? ` at ~${result.wall.rem}% boss health${result.multiPhase ? ` (phase ${result.wall.phase})` : ""}` : "";
    result.findings.push(finding("Info", NOTE,
      `No one keeps dying early — your pulls end with the raid going down together${wallTxt}. ` +
      `That's a DPS/enrage wall or a raid-wide mechanic to out-gear or solve, not individual deaths.`));
  }
  return result;
}

// Estimate whether the raid is DAMAGE-gated: from the deepest wipe, infer the
// boss's effective HP (damage dealt / fraction killed) and compare the raid DPS to
// what the FIELD's kill time implies is needed. NO hard-coded enrage -- the field's
// own kill duration is the reference. Names the lowest contributors on that pull.
async function dpsCheck(result, analyzed) {
  const deepest = result.deepest;
  if (!deepest) return;
  const recent = analyzed[analyzed.length - 1];
  const fids = [...new Set([deepest.id, recent.id])];
  const cores = await mapLimit(fids, 2, (fid) => reportCore(result.code, fid).catch(() => null));
  const deep = cores[0]; if (!deep || !deep.dmg || !deep.dmg.data) return;
  const data = deep.dmg.data;
  // Players only: drop NPC/Boss rows, and Pets (separate entries here) so a pet is
  // never named as a "low contributor". Pet damage is small enough that omitting it
  // from the raid-DPS estimate is within this check's already-rough tolerance.
  const entries = (data.entries || []).filter((e) => !/^(NPC|Boss|Pet)$/i.test(e.type || ""));
  const durSec = secs(data.totalTime || (deepest.endTime - deepest.startTime));
  if (!(durSec > 0) || !entries.length) return;
  const raidDamage = entries.reduce((s, e) => s + (e.total || 0), 0);
  const raidDps = raidDamage / durSec;
  const fractionKilled = Math.min(1, Math.max(0.01, 1 - (result.bestRemaining / 100)));
  const bossHp = raidDamage / fractionKilled;

  const killMs = median(await encounterKillTimes(result.encounterID, result.difficulty));
  if (!(killMs > 0)) return;                       // no field reference -> skip the check
  const requiredDps = bossHp / secs(killMs);
  const deficit = Math.max(0, ((requiredDps - raidDps) / requiredDps) * 100);
  result.dps = { raidDps, requiredDps, deficit, fieldKillMin: secs(killMs) / 60, killedPct: Math.round(fractionKilled * 100) };

  // Fire only on a meaningful deficit. We do NOT suppress it just because people
  // died — when the raid dies TOGETHER at the wall (no recurring EARLY cause), that
  // cluster IS the enrage/DPS wall, so the deficit is exactly the lever. If there's
  // also a real early-death cause, note that it comes first; impact-sort orders them.
  if (deficit < 5) return;
  if (result.hasEarlyCause) result.notes.push(
    `Damage is also ~${Math.round(deficit)}% light — but fix the early deaths first, then re-check the wall.`);
  // Bottom contributors on the deepest pull, relative to the raid median (named).
  const dpsList = entries.map((e) => ({ name: e.name, cls: e.type, dps: (e.total || 0) / durSec }))
    .filter((x) => x.dps > 0).sort((a, b) => a.dps - b.dps);
  const med = median(dpsList.map((x) => x.dps));
  const laggards = dpsList.filter((x) => x.dps < med * LAGGARD_FRAC).slice(0, 3)
    .map((x) => `${x.name}${x.cls ? ` (${x.cls})` : ""}`);
  const lagTxt = laggards.length
    ? ` Lowest vs the raid median: ${laggards.join(", ")} — check their rotation/uptime first.`
    : "";
  result.findings.push(finding("DPSCheck", GATE(deficit),
    `**Raid is ~${Math.round(deficit)}% short on DPS** to beat the gate: you got the boss to ${result.dps.killedPct}% killed, ` +
    `but at this rate it'd take longer than the field's ~${result.dps.fieldKillMin.toFixed(1)}-min kill.${lagTxt}`));
}

// What changed across the night: who joined/left between the FIRST analyzed pull
// and the deepest one. A roster swap that coincides with deeper progress is the
// backtest signal ("adding X pushed you to Y%").
function rosterDelta(result, pulls, roster) {
  const wipes = pulls.filter((p) => !p.kill);
  if (wipes.length < 4 || !result.deepest) return;
  const nameSet = (p) => new Set((p.friendlyPlayers || []).map((id) => (roster.get(id) || {}).name).filter(Boolean));
  const early = nameSet(wipes[0]);
  const deep = nameSet(result.deepest);
  if (!early.size || !deep.size) return;
  const added = [...deep].filter((n) => !early.has(n));
  const dropped = [...early].filter((n) => !deep.has(n));
  if (!added.length && !dropped.length) return;
  const parts = [];
  if (added.length) parts.push(`added ${added.slice(0, 4).join(", ")}`);
  if (dropped.length) parts.push(`without ${dropped.slice(0, 4).join(", ")}`);
  result.findings.push(finding("Roster", NOTE,
    `Roster changed during progression (${parts.join("; ")}). Your deepest pull (${Math.round(result.bestRemaining)}% left) was with the later comp — keep that group together.`));
}

// ----------------------------------------------------------------------------- //
// Streaming output (CLI + the web card). Same line vocabulary as the other
// modules: "=== HEAD ===", "--- sub ---", numbered "N. [label] text" findings
// (rendered as action rows), and aligned readout rows for the pull list.
// ----------------------------------------------------------------------------- //
export async function run(log, ref, { encounterId = null, fresh = false } = {}) {
  const code = typeof ref === "string" ? ref : (ref && ref.code);
  if (!code) { log("[error] No report code — paste a Warcraft Logs report URL."); return null; }
  const r = await progressionFindings(code, { encounterId, fresh });
  if (!r) { log("[error] No boss pulls found in that report."); return null; }

  const diff = DIFFICULTY[r.difficulty] || "";
  log(`=== ${diff} ${r.boss} — ${r.nPulls} pulls (${r.nKills} kill${r.nKills === 1 ? "" : "s"}, ${r.nWipes} wipes) ===`);
  if (r.deepest) {
    const w = r.wall;
    const wallTxt = w
      ? ` Recent wipes wall at ~${w.rem}% left${r.multiPhase ? ` (phase ${w.phase})` : ""} (${w.n}/${r.recentWipes.length} of the last pulls).`
      : "";
    log(`-> Deepest pull: ${Math.round(r.bestRemaining)}% boss health left.${wallTxt}`);
  }
  log("");
  log("--- What to change to kill it ---");
  r.findings.forEach((fd, i) => log(`${i + 1}. [ ${fd.label} ] ${fd.text}`));
  for (const n of r.notes) log(`-> ${n}`);

  // Pull-by-pull readout -- the backtest trend (most recent last). Show only ended
  // pulls' progress so the wall is visible.
  log("");
  log("--- Pull-by-pull (boss % left at wipe) ---");
  const shown = r.pulls.slice(-Math.min(20, r.pulls.length));
  shown.forEach((p) => {
    const idx = r.pulls.indexOf(p) + 1;
    const rem = p.kill ? "KILL" : `${Math.round(p.fightPercentage != null ? p.fightPercentage : (p.bossPercentage || 100))}%`;
    const ph = r.multiPhase ? `  P${p.lastPhase || 0}` : "";
    const dur = Math.round(secs((p.endTime || 0) - (p.startTime || 0)));
    const link = wclReport(code, p.id, `pull ${idx}`);
    log(`  ${link.padEnd(0)}  ${String(rem).padStart(5)}${ph}  ${dur}s${p.kill ? "  <-- kill" : ""}`);
  });
  if (r.dps) {
    log("");
    log("--- DPS check ---");
    log(`  raid DPS on deepest pull: ${f(r.dps.raidDps / 1e6, 2)}M  ·  needed for a field-paced (~${r.dps.fieldKillMin.toFixed(1)}m) kill: ${f(r.dps.requiredDps / 1e6, 2)}M  (${Math.round(r.dps.deficit)}% short)`);
  }
  return r;
}

// Multi-night trend: best boss-% reached per report, newest last. A lightweight
// backtest across the tier so the group can see whether nights are converging.
// `reports` = [{ code, startTime }]; fetches one reportFights each (cheap).
export async function nightlyTrend(reports, encounterId, { limit = 8 } = {}) {
  const recent = [...reports].sort((a, b) => (a.startTime || 0) - (b.startTime || 0)).slice(-limit);
  const rows = await mapLimit(recent, 4, async (rep) => {
    try {
      const fights = await reportFights(rep.code);
      const enc = pickEncounter(fights, encounterId);
      if (!enc) return null;
      const wipes = enc.pulls.filter((p) => !p.kill);
      const killed = enc.pulls.some((p) => p.kill);
      const rem = (p) => (p.fightPercentage != null ? p.fightPercentage : (p.bossPercentage != null ? p.bossPercentage : 100));
      const best = wipes.length ? Math.min(...wipes.map(rem)) : 0;
      return { code: rep.code, startTime: rep.startTime, pulls: enc.pulls.length, best: killed ? 0 : best, killed };
    } catch { return null; }
  });
  return rows.filter(Boolean);
}
