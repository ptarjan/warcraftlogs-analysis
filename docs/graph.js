// @ts-check
// Visual throughput-over-time card: YOUR damage (or healing) curve over your
// benchmark kill, overlaid on the ilvl-matched field's BAND (median + 25-75%
// interquartile), plus a read on WHERE in the fight you can gain. The picture the
// text Timeline diagnosis can't draw; it points at the window, the Timeline /
// Rotation cards size the lever. Same compute/render split as every other module.
import {
  characterZone, characterEncounter, playerMetrics, ilvlPeers, PEER_SAMPLE, BOSS_FANOUT,
  median, collectUpTo, mapLimit, bestRank, dpsOverTime, metricUnit, runIsHealer, isSupport,
  fightWindow, fightEvents, abilityCurvesOverTime, selfBuffIntervals, finding, DIM, DPS, INFO, KIND,
} from "./core.js";

// Browser renders the chart as an inline SVG (app.js), the CLI as an ASCII sparkline.
// app.js detects this exact prefix on a streamed line, parses the JSON, and draws it
// (and a shared snapshot replays the same line -> the chart survives sharing).
export const CHART_PREFIX = "\u0001CHART";

const G = 48;              // base grid resolution across the fight
const DIP_FLOOR = 0.12;    // a window must trail the field median by >=12% to call it out

// Linear interp of a uniformly-sampled curve at fraction f in [0,1].
function at(arr, f) {
  const m = arr.length;
  if (!m) return 0;
  if (m === 1) return arr[0];
  const x = Math.max(0, Math.min(1, f)) * (m - 1);
  const i = Math.floor(x), frac = x - i;
  return i + 1 < m ? arr[i] * (1 - frac) + arr[i + 1] * frac : arr[i];
}

// Resample a uniformly-sampled curve to n points across the WHOLE fight (the fallback
// when phases can't be aligned -- overlays by raw fraction-of-fight).
function resample(arr, n) {
  return Array.from({ length: n }, (_, g) => at(arr, n <= 1 ? 0.5 : g / (n - 1)));
}

// Per-PHASE width allocation: each phase gets grid points proportional to its MEDIAN
// fraction-of-fight across the kills, so a long phase stays wide and a short
// intermission narrow -- while every kill's phase p lands in the SAME slot (aligned
// boundaries). Returns integer widths summing to ~G.
function phaseWidths(actorFracs, base) {
  const P = actorFracs[0].length;
  const medW = [];
  for (let p = 0; p < P; p++) {
    const ws = actorFracs.map((fr) => (p + 1 < fr.length ? fr[p + 1] : 1) - fr[p]);
    medW.push(Math.max(0, median(ws)));
  }
  const sum = medW.reduce((a, b) => a + b, 0) || 1;
  return medW.map((w) => Math.max(2, Math.round((base * w) / sum)));
}

// The fraction-of-fight each grid slot samples, given phase boundaries + widths -- the
// inverse map (grid index -> where in THIS kill it falls) used to align a curve AND to
// locate a window back in real fight time (for the cast-activity diagnosis).
function alignFracs(fracs, widths) {
  const out = [];
  for (let p = 0; p < widths.length; p++) {
    const a = fracs[p], b = p + 1 < fracs.length ? fracs[p + 1] : 1;
    const w = widths[p];
    for (let k = 0; k < w; k++) out.push(w === 1 ? (a + b) / 2 : a + (b - a) * (k / (w - 1)));
  }
  return out;
}
// Resample EACH phase of a curve to its allotted width -> a curve whose phase boundaries
// align with every other curve aligned to the same widths.
function alignCurve(dps, fracs, widths) {
  return alignFracs(fracs, widths).map((f) => at(dps, f));
}

// Linear-interpolated quantile of an already-sorted array.
function quant(sorted, q) {
  if (!sorted.length) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// The dip the prescription should carry: your BIGGEST gainable dip across ALL bosses, not
// whichever boss happened to be the gear benchmark. The tool sorts biggest-gain-first, so
// the worst boss is the one worth fixing (on Hadryan that's Chimaerus P3 ~10%, not Crown P5
// ~5%). Scan every boss shallow (cheap -- shares the card's fetches), pick the largest
// gainPct, then DEEP-diagnose just that one for the actionable lever. Returns null when no
// boss has a real dip (-> no lever, not a fake one).
export async function graphFindings(name, server, region, className, specName, difficulty) {
  // Support specs (Augmentation): personal damage isn't their lever -> no dip lever.
  if (isSupport(specName)) return { skip: "support" };
  let ranks;
  try {
    const c = await characterZone(name, server, region, difficulty);
    ranks = (c.zoneRankings.rankings || []).filter((r) => (r.totalKills || 0) > 0 && r.rankPercent != null);
  } catch { return null; }
  if (!ranks.length) return null;
  const scans = await mapLimit(ranks, BOSS_FANOUT, async (r) => {
    try { const s = /** @type {any} */ (await analyzeBoss(name, server, region, r.encounter, difficulty, className, specName, { deep: false })); return s && s.worst ? { r, s } : null; }
    catch { return null; }
  });
  const dips = scans.filter((x) => x && x.s.worst.deficit >= DIP_FLOOR && (x.s.worst.gainPct || 0) >= 1)
    .sort((a, b) => (b.s.worst.gainPct || 0) - (a.s.worst.gainPct || 0));
  if (!dips.length) return null;
  return analyzeBoss(name, server, region, dips[0].r.encounter, difficulty, className, specName, { deep: true });
}

// Per-BOSS worker: your representative kill of THIS boss vs the ilvl-matched field band
// (phase-aligned), plus the dip diagnosis. `deep` gates the EXPENSIVE attribution
// (per-ability curves + self-buff events) -- ON for the prescription's one benchmark boss,
// OFF for the per-boss CARD that fans out over every boss (only the cheap cause read, off
// cached casts, runs there). Returns the per-boss result, a {skip} marker, or null.
export async function analyzeBoss(name, server, region, encounter, difficulty, className, specName, { deep = false } = {}) {
  const er = await characterEncounter(name, server, region, encounter.id, difficulty);
  const best = bestRank(er && er.ranks, specName);
  if (!best) return null;
  const code = best.report.code, fight = best.report.fightID;
  const you = await playerMetrics(code, fight, name, specName, className);
  if (!you) return null;
  const yc = await dpsOverTime(code, fight, you.sourceID);
  if (!yc) return null;

  // The SAME ilvl-matched field every other comparison uses (shared selection -> the
  // per-peer reportCore reads dedupe with timeline/prescribe; only the graph query is new).
  const cands = await ilvlPeers(name, server, region, encounter, difficulty, className, specName);
  const peers = await collectUpTo(cands, PEER_SAMPLE, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (!m) return null;
    const cc = await dpsOverTime(r.report.code, r.report.fightID, m.sourceID);
    return cc ? { dps: cc.dps, phases: cc.phases, overall: m.dps } : null;
  });
  const cmp = buildCurveComparison(yc, peers);
  if (!cmp) return { skip: "fewpeers", boss: encounter.name };

  // DIAGNOSE the dip. Cast rate DURING the dip window vs the whole fight (cached casts):
  // collapses -> you go passive (movement/coast); holds but damage is down -> cooldown/amp
  // timing. The deep attribution (which ability / which cooldown) only runs when asked.
  const w = cmp.worst;
  if (w && w.deficit >= DIP_FLOOR && !runIsHealer()) {
    try {
      const [fS, fE] = await fightWindow(code, fight);
      const durMs = fE - fS;
      const { casts } = await fightEvents(code, fight, you.sourceID, fS, fE);
      const ts = casts.map((e) => e.timestamp);
      const winMin = Math.max(0.05, ((w.fracEnd || 1) - (w.fracStart || 0)) * durMs / 60000), fightMin = Math.max(0.05, durMs / 60000);
      const aMs = fS + (w.fracStart || 0) * durMs, bMs = fS + (w.fracEnd || 1) * durMs;
      const cpmWin = ts.filter((t) => t >= aMs && t <= bMs).length / winMin;
      const cpmAll = ts.length / fightMin;
      w.cpmRatio = cpmAll > 0 ? cpmWin / cpmAll : 1;
      w.cause = w.cpmRatio < 0.78 ? "idle" : "cooldown";
      // Cast rate normal but damage down -> ATTRIBUTE the drop to a button. Per-ability
      // damage curves: is ONE ability way down (press THAT), or is every ability down ~the
      // same % (a flat amp/cooldown landing earlier -- NOT one button, it's timing)?
      if (deep && w.cause === "cooldown") {
        const curves = await abilityCurvesOverTime(code, fight, you.sourceID);
        const winMean = (d) => { let s2 = 0, n2 = 0; for (let i = 0; i < d.length; i++) { const f = d.length <= 1 ? 0 : i / (d.length - 1); if (f >= (w.fracStart || 0) && f <= (w.fracEnd || 1)) { s2 += d[i]; n2++; } } return n2 ? s2 / n2 : 0; };
        const allMean = (d) => d.reduce((a, b) => a + b, 0) / (d.length || 1);
        const rows = curves.map((c) => { const fm = allMean(c.data), wm = winMean(c.data); return { name: c.name, fm, wm, drop: Math.max(0, fm - wm), pct: fm > 0 ? (fm - wm) / fm : 0 }; })
          .filter((r) => r.fm > 0).sort((a, b) => b.drop - a.drop);
        const totalDrop = rows.reduce((a, b) => a + b.drop, 0) || 1;
        const top = rows[0];
        if (top && top.drop / totalDrop >= 0.4 && (!rows[1] || top.drop >= rows[1].drop * 1.5)) {
          w.culprit = { name: top.name, normalK: Math.round(top.fm / 1000), windowK: Math.round(top.wm / 1000) };
        } else if (rows.length >= 3) {
          w.uniform = true;                                  // drop spread evenly -> an amp, not a button
          w.uniformPct = Math.round(100 * median(rows.slice(0, 5).map((r) => r.pct)));
          // A uniform drop COULD be a damage cooldown landing earlier -- but ONLY claim
          // that if a cooldown is ACTUALLY mistimed. Find your self-buffs that are damage
          // AMPS (presence lifts your DPS) and check if any covers the window LESS than the
          // rest. If one does -> name it. If your cooldowns DO cover the window -> say so:
          // the even drop is then target count (less cleave) / a raid cooldown, not yours.
          const { intervals, names, start: bS, end: bE } = await selfBuffIntervals(code, fight, you.sourceID);
          const bd = bE - bS, L = yc.dps.length;
          const upt = (iv, a, b) => { let u = 0; for (const [x, y] of (iv || [])) { const lo = Math.max(x, a), hi = Math.min(y, b); if (hi > lo) u += hi - lo; } return (b - a) > 0 ? u / (b - a) : 0; };
          const mean = (arr) => arr.reduce((x, y) => x + y, 0) / (arr.length || 1);
          const aMs2 = bS + (w.fracStart || 0) * bd, bMs2 = bS + (w.fracEnd || 1) * bd;
          let best = null, sawAmp = false;
          for (const g of Object.keys(intervals)) {
            const whole = upt(intervals[g], bS, bE);
            if (whole < 0.08 || whole > 0.75) continue;      // skip permanents (flask/Stagger) + rare procs
            const act = [], ina = [];
            for (let i = 0; i < L; i++) (upt(intervals[g], bS + (i / L) * bd, bS + ((i + 1) / L) * bd) >= 0.5 ? act : ina).push(yc.dps[i]);
            if (act.length < 2 || ina.length < 2 || mean(act) / (mean(ina) || 1) < 1.2) continue;   // not a damage amp
            sawAmp = true;
            const inWin = upt(intervals[g], aMs2, bMs2);
            const outWin = (whole * bd - inWin * (bMs2 - aMs2)) / Math.max(1, bd - (bMs2 - aMs2));
            // name=null when the buff isn't in the table or its id doesn't match (procs /
            // aura-id mismatches) -- then we WON'T assert "shift X", we'll say so honestly.
            const nm = names[g];
            const named = nm && !/^id\d+$/.test(nm) ? nm : null;
            if (outWin - inWin >= 0.15 && (!best || outWin - inWin > best.drop)) best = { name: named, inPct: Math.round(100 * inWin), outPct: Math.round(100 * outWin), drop: outWin - inWin };
          }
          if (best) w.cooldown = best;                       // an amp IS mistimed (named or not)
          else if (sawAmp) w.cdsCover = true;                // your cooldowns DO cover the window -> not timing
        }
      }
    } catch (e) { /* no cast/ability data -> leave cause/culprit unset (run() degrades to a generic read) */ }
  }

  return {
    boss: encounter.name, unit: metricUnit(), isHealer: runIsHealer(),
    ...cmp, yourOverall: you.dps, peerOverall: median(peers.map((p) => p.overall)), peers: peers.length,
  };
}

// The prescription lever(s) from the dip -- so this card feeds the one list, not just
// the card. Measured OWN-BASELINE (your window vs YOUR OWN typical, gainable for elite
// and average alike). A COOLDOWN-misalignment dip is a real, sized lever (cast rate
// normal but output down -> your burst landed elsewhere; DPS the cast/uptime aggregates
// miss because it's about WHEN you press). An IDLE dip is the SAME loss the Execution
// "lost GCDs" lever already sizes, so it's an INFO that LOCATES it (impact 0 -> no
// double-count). Healers/support: no lever (curve is informational only).
const kfmt = (n) => `${Math.round((n || 0) / 1000)}k`;
export function graphLevers(d) {
  if (!d || d.skip || d.isHealer) return [];
  const w = d.worst;
  if (!w || w.deficit < DIP_FLOOR || !(w.gainPct >= 1)) return [];
  const where = w.phase ? `Phase ${w.phase}` : w.center < 1 / 3 ? "the opener" : w.center < 2 / 3 ? "mid-fight" : "the execute";
  const unit = d.unit || "DPS";
  // Same ALL-CAPS-label house style as every other lever (and the rotation weak-window
  // it replaces): "DAMAGE TIMELINE: ...". Sized OWN-BASELINE (vs YOUR own typical); the
  // field-holds clause is the measured "others sustain here, so it's a real hole" -- the
  // window only fires when the field does NOT drop there (see buildCurveComparison).
  const head = `DAMAGE TIMELINE: in ${where} on ${d.boss} your ${unit} drops to ~${kfmt(w.youWindow)} vs your own ~${kfmt(w.youTypical)} the rest of the kill -- and the field holds its pace here (~${kfmt(w.fieldWindow)}), so it's a real hole, not a low-damage phase`;
  if (w.cause === "idle") {
    // A LOCALIZED idle hole (you go quiet in one phase) -- sized, because the whole-fight
    // "press faster" lever is silent for an active player, so this is the gainable lever.
    return [finding(DIM.EXECUTION, DPS(w.gainPct),
      `${head}. Your cast rate falls to ${Math.round(100 * (w.cpmRatio || 0))}% of normal in ${where}, so you go quiet there -- keep your rotation going through its movement/mechanics instead of coasting.`,
      "measured", KIND.PHASE_DIP)];
  }
  // Cast rate normal but output down -> attribute it from YOUR data:
  //  - one ability dominates the drop -> name it ("press THAT").
  //  - a self damage-cooldown is genuinely MISTIMED (covers the window less) -> name it.
  //  - cooldowns DO cover the window (cdsCover) -> it's NOT timing; the even drop is target
  //    count (less cleave) or a raid cooldown earlier -> honest INFO, not a personal lever.
  //  - couldn't read buffs -> a hedged generic note.
  if (w.culprit) {
    return [finding(DIM.EXECUTION, DPS(w.gainPct),
      `${head}. You press just as much there, but your ${w.culprit.name} is way down (~${w.culprit.windowK}k vs ~${w.culprit.normalK}k the rest of the kill) -- make sure you're landing it in ${where}.`,
      "measured", KIND.PHASE_DIP)];
  }
  if (w.cooldown && w.cooldown.name) {
    return [finding(DIM.EXECUTION, DPS(w.gainPct),
      `${head}. Your ${w.cooldown.name} covers only ${w.cooldown.inPct}% of ${where} vs ${w.cooldown.outPct}% the rest of the kill -- shift it to cover ${where}.`,
      "measured", KIND.PHASE_DIP)];
  }
  if (w.cooldown) {
    // The HOLE is measured (own-baseline, field holds) -> keep it sized. An amp IS less
    // active in the window, but we couldn't NAME it (proc / aura-id mismatch) -> hedge the
    // cause and point the player at their own cooldowns rather than assert a spell.
    return [finding(DIM.EXECUTION, DPS(w.gainPct),
      `${head}. A damage buff of yours is less active here (~${w.cooldown.inPct}% of ${where} vs ${w.cooldown.outPct}% elsewhere) -- I can't name it from the log, so check that your damage cooldowns line up with ${where} (it may also be a proc or a raid cooldown).`,
      "measured", KIND.PHASE_DIP)];
  }
  if (w.cdsCover) {
    // Your cooldowns already cover the window -> NOT a timing lever. Don't claim gainable
    // DPS; record it as an INFO so the list isn't padded with a fix that isn't yours.
    return [finding(DIM.EXECUTION, INFO,
      `${head}. But your damage cooldowns DO cover ${where} -- so this isn't cooldown timing. Every ability just hits ~${w.uniformPct || 0}% softer there, which usually means fewer targets (less cleave) or a raid cooldown (e.g. Bloodlust) used earlier -- likely not a personal lever to fix.`,
      "measured", KIND.PHASE_DIP)];
  }
  const tail = w.cause !== "cooldown"
    ? `. Keep your uptime and cooldowns lined up through it.`
    : `. You press just as much there (cast rate normal), so your hits land softer -- a damage cooldown is landing earlier. Check that your cooldowns cover ${where}.`;
  return [finding(DIM.EXECUTION, DPS(w.gainPct), head + tail, "measured", KIND.PHASE_DIP)];
}

// Pure: turn your curve + the peer curves into the aligned band + the worst-dip read.
// Separated from the fetching so it's unit-testable (and the phase-alignment math, the
// part most likely to regress, is exercised directly). `yc` = { dps, phases }; each peer
// = { dps, phases }. Returns null when there's too little to compare.
export function buildCurveComparison(yc, peers) {
  if (!yc || !yc.dps || (peers || []).length < 2) return null;

  // PHASE-ALIGN when we can: bosses clear phases at different speeds, so phase p ends at
  // a different fight-% each kill -- raw fraction-of-fight overlays an intermission onto a
  // burn. We resample each phase separately so boundaries line up. Needs the SAME phase
  // count across kills (same boss/difficulty -> usually true); peers with a different count
  // are dropped from the band (rare). If too few align, fall back to whole-fight resample.
  const refP = (yc.phases || [0]).length;
  const aligned = refP > 1 && peers.filter((p) => (p.phases || [0]).length === refP).length >= 2;
  let you48, peer48, youFrac, bounds = [];
  if (aligned) {
    const pool = peers.filter((p) => (p.phases || [0]).length === refP);
    const widths = phaseWidths([yc.phases, ...pool.map((p) => p.phases)], G);
    you48 = alignCurve(yc.dps, yc.phases, widths);
    peer48 = pool.map((p) => alignCurve(p.dps, p.phases, widths));
    youFrac = alignFracs(yc.phases, widths);          // grid -> fraction of YOUR fight
    // grid index where each phase (2..P) begins -> chart dividers + phase labels
    let acc = 0;
    for (let p = 0; p < widths.length - 1; p++) { acc += widths[p]; bounds.push(acc); }
  } else {
    you48 = resample(yc.dps, G);
    peer48 = peers.map((p) => resample(p.dps, G));
    youFrac = you48.map((_, g) => (you48.length <= 1 ? 0.5 : g / (you48.length - 1)));
  }
  const N = you48.length;
  const pmed = [], plo = [], phi = [];
  for (let g = 0; g < N; g++) {
    const col = peer48.map((pg) => pg[g]).sort((a, b) => a - b);
    pmed[g] = quant(col, 0.5); plo[g] = quant(col, 0.25); phi[g] = quant(col, 0.75);
  }

  // ONLY compare where the field is actually dealing damage. Phased fights have
  // intermissions / untargetable windows where the field median craters to ~0 (and,
  // because phase lengths vary kill-to-kill, the %-normalized boundary smears). Counting
  // your damage there vs a ~0 field would inflate "above the field" on add/pre-phase
  // padding -- noise, not a lever. `live` gates the stats to the genuine-damage regions;
  // the chart still DRAWS the full curve (the intermission dip is honest to show).
  const peak = Math.max(...pmed);
  const live = pmed.map((v) => v >= peak * 0.15);
  const liveN = live.filter(Boolean).length || 1;

  // Where you sit relative to the field band (the VISUAL summary only -- "ahead of /
  // with / under the field"). NOT what the lever is sized on.
  let below = 0, above = 0;
  for (let g = 0; g < N; g++) {
    if (!live[g]) continue;
    if (you48[g] < plo[g]) below++; else if (you48[g] > phi[g]) above++;
  }

  // The dip is sized OWN-BASELINE (where YOUR output trails YOUR OWN typical), NOT the
  // field median -- field-relative is the high-percentile trap (a player 45% ahead of the
  // field can be "under the field median" in a phase they front-load, nothing gainable).
  // BUT it must also be a YOU-SPECIFIC hole: the field has to HOLD its pace in that window
  // too. If everyone drops there (movement phase, fewer targets, boss damage reduction),
  // it's an inherent low-damage phase, NOT something you can fix -- so we require the field
  // to sustain (its own drop < 15%). That's the measured answer to "do others sustain
  // here?" -- only windows where they do get flagged. (Same logic as the rotation weak
  // window; here it's phase-aligned.) The field band also stays as the chart's visual.
  const liveYou = you48.filter((_, g) => live[g]);
  const liveFld = pmed.filter((_, g) => live[g]);
  const yourTypical = liveYou.length ? median(liveYou) : (median(you48) || 1);
  const fieldTypical = liveFld.length ? median(liveFld) : (median(pmed) || 1);
  const W = Math.max(4, Math.round(N * 0.18));
  /** @type {{start:number,end:number,deficit:number,center:number,phase?:number,nPhases?:number,gainPct?:number,fracStart?:number,fracEnd?:number,cause?:string,cpmRatio?:number,youTypical?:number,youWindow?:number,fieldWindow?:number,culprit?:{name:string,normalK:number,windowK:number},uniform?:boolean,uniformPct?:number,cooldown?:{name:string,inPct:number,outPct:number,drop:number},cdsCover?:boolean}|null} */
  let worst = null;
  for (let i = 0; i + W <= N; i++) {
    let youSum = 0, fldDrop = 0, fldSum = 0, n = 0;
    for (let g = i; g < i + W; g++) if (live[g]) {
      youSum += (yourTypical - you48[g]) / yourTypical;
      fldDrop += (fieldTypical - pmed[g]) / fieldTypical;
      fldSum += pmed[g]; n++;
    }
    if (n < W / 2) continue;                                  // mostly-intermission window -> skip
    if (fldDrop / n > 0.15) continue;                         // field ALSO drops here -> inherent low phase, not gainable
    const deficit = youSum / n;                               // avg fraction below YOUR typical, where the field holds
    if (!worst || deficit > worst.deficit) worst = { start: i, end: i + W, deficit, center: (i + W / 2) / N, fieldWindow: fldSum / n };
  }
  // Which phase the dip falls in (aligned runs only) + SIZE it in overall-DPS terms: the
  // damage if you held your own typical across the window, as a % of your whole-fight
  // output (grid slots are ~equal wall-time -> sum of per-slot deficits / your total).
  if (worst) {
    if (bounds.length) {
      const c = (worst.start + worst.end) / 2;
      worst.phase = bounds.filter((b) => b <= c).length + 1;   // 1-based phase number
      worst.nPhases = bounds.length + 1;
    }
    const youSum = you48.reduce((a, b) => a + b, 0) || 1;
    let defSum = 0, winSum = 0, winN = 0;
    for (let g = worst.start; g < worst.end; g++) if (live[g]) { defSum += Math.max(0, yourTypical - you48[g]); winSum += you48[g]; winN++; }
    worst.gainPct = Math.round((100 * defSum) / youSum);
    worst.youTypical = yourTypical;
    worst.youWindow = winN ? winSum / winN : 0;
    worst.fracStart = youFrac[worst.start];
    worst.fracEnd = youFrac[Math.min(N - 1, worst.end)];
  }

  return {
    n: N, you: you48, pmed, plo, phi, worst, bounds, aligned,
    bandBelow: below / liveN, bandAbove: above / liveN, bandIn: (liveN - below - above) / liveN,
  };
}

// Compact, rounded payload for the SVG (keeps the shared snapshot small).
function chartData(d) {
  const r = (a) => a.map((v) => Math.round(v));
  return {
    boss: d.boss, unit: d.unit, you: r(d.you), pmed: r(d.pmed), plo: r(d.plo), phi: r(d.phi),
    bounds: d.bounds || [], aligned: !!d.aligned,
    worst: d.worst && d.worst.deficit >= DIP_FLOOR ? { start: d.worst.start, end: d.worst.end } : null,
  };
}

// CLI fallback: two block-sparklines (you vs field) with phase dividers (│) where the
// aligned phase boundaries fall, so the terminal view shows the same alignment.
function asciiChart(log, d) {
  const blocks = "▁▂▃▄▅▆▇█";
  const mx = Math.max(1, ...d.pmed, ...d.you);
  const bset = new Set(d.bounds || []);
  const spark = (arr) => arr.map((v, i) =>
    (bset.has(i) ? "│" : "") + blocks[Math.min(7, Math.max(0, Math.round((7 * v) / mx)))]).join("");
  log(`  you   ${spark(d.you)}`);
  log(`  field ${spark(d.pmed)}`);
  if (d.bounds && d.bounds.length) {
    // phase ruler: P1, P2... at each segment
    let line = "        ", prev = 0;
    (d.bounds.concat([d.you.length])).forEach((b, i) => {
      const seg = b - prev; line += `P${i + 1}`.padEnd(Math.max(2, seg + (bset.has(prev) ? 1 : 0))); prev = b;
    });
    log(line);
  }
}

// Render ONE boss's chart + dip line (the card fans this out over every boss). The deep
// attribution (culprit / named cooldown / cdsCover) only appears on the prescription's
// benchmark boss; the card is deep:false, so here the dip reads cause-only -- still the
// where + own-baseline drop + field-holds, just deferring the exact cooldown to the list.
function renderBoss(log, d, unit) {
  const g = /** @type {any} */ (d);
  log("");
  if (typeof document !== "undefined") log(CHART_PREFIX + JSON.stringify(chartData(g)));
  else asciiChart(log, g);
  log(`  ${g.boss} · your kill vs ${g.peers} peers at your item level${g.aligned ? " · aligned by phase" : ""}.`);
  if (g.isHealer) { log("  HPS tracks incoming raid damage (reactive) — see the Healing card for overhealing/mana."); return; }
  const w = g.worst;
  const kk = (n) => `${Math.round((n || 0) / 1000)}k`;
  if (!(w && w.deficit >= DIP_FLOOR)) { log("  -> You hold your level wherever the field does — no soft spot here."); return; }
  const where = w.phase ? `Phase ${w.phase}` : w.center < 1 / 3 ? "your opener" : w.center < 2 / 3 ? "the middle" : "the execute";
  const drop = `${where}: your ${unit} drops to ~${kk(w.youWindow)} vs your own ~${kk(w.youTypical)} the rest of the kill, while the field holds ~${kk(w.fieldWindow)}`;
  if (w.cause === "idle") log(`  -> ${drop} — your cast rate falls to ${Math.round(100 * (w.cpmRatio || 0))}% of normal, so you go quiet there. Keep pressing through it. (~${w.gainPct}%)`);
  else if (w.culprit) log(`  -> ${drop} — your ${w.culprit.name} is way down (~${w.culprit.windowK}k vs ~${w.culprit.normalK}k); land it in ${where}. (~${w.gainPct}%)`);
  else if (w.cooldown && w.cooldown.name) log(`  -> ${drop} — your ${w.cooldown.name} covers only ${w.cooldown.inPct}% of ${where} vs ${w.cooldown.outPct}% elsewhere; shift it. (~${w.gainPct}%)`);
  else if (w.cdsCover) log(`  -> ${drop} — but your cooldowns cover ${where}, so it's likely target count / a raid cooldown, not a personal lever.`);
  else log(`  -> ${drop} — you press just as much, so your hits land softer there (a cooldown/amp timing thing). (~${w.gainPct}%)`);
}

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster", difficulty = 5) {
  const unit = metricUnit();
  log("");
  log(`=== ${unit} over the fight: ${name} vs the ilvl-matched field (one chart per boss) ===`);
  if (isSupport(specName)) { log("  Support spec -- personal damage isn't the lever; see the Support buffs card for your ally value."); return; }
  let ranks;
  try {
    const c = await characterZone(name, server, region, difficulty);
    ranks = (c.zoneRankings.rankings || []).filter((r) => (r.totalKills || 0) > 0 && r.rankPercent != null);
  } catch (e) { log(`  (couldn't load your kills: ${e.message || e})`); return; }
  if (!ranks.length) { log("  (no ranked kills with a peer field to chart.)"); return; }
  // One chart per boss you've killed -- fan the bosses out (each an independent peer-fetch
  // wave; analyzeBoss is deep:false so the card stays cheap -- only the cause read per boss,
  // off cached casts). The deep cooldown diagnosis lives in the prescription (benchmark boss).
  const results = await mapLimit(ranks, BOSS_FANOUT, async (r) => {
    try { return await analyzeBoss(name, server, region, r.encounter, difficulty, className, specName, { deep: false }); }
    catch (e) { return { boss: r.encounter.name, err: e.message || String(e) }; }
  });
  let shown = 0;
  for (const d of results) {
    if (!d) continue;
    if (d.err) { log(""); log(`  ${d.boss}: (couldn't chart — ${d.err})`); continue; }
    if (d.skip === "fewpeers") { log(""); log(`  ${d.boss}: too few ilvl-matched peers loaded to draw a field band.`); continue; }
    renderBoss(log, d, unit); shown++;
  }
  if (!shown) log("  (no boss had enough ilvl-matched peers to chart.)");
}
