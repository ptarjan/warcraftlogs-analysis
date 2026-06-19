// @ts-check
// Visual throughput-over-time card: YOUR damage (or healing) curve over your
// benchmark kill, overlaid on the ilvl-matched field's BAND (median + 25-75%
// interquartile), plus a read on WHERE in the fight you can gain. The picture the
// text Timeline diagnosis can't draw; it points at the window, the Timeline /
// Rotation cards size the lever. Same compute/render split as every other module.
import {
  characterZone, characterEncounter, playerMetrics, ilvlPeers, PEER_SAMPLE,
  median, collectUpTo, mapLimit, bestRank, dpsOverTime, metricUnit, runIsHealer, isSupport,
  fightWindow, fightEvents, finding, DIM, DPS, INFO, KIND,
} from "./core.js";
import { pickBenchmarkKill } from "./prescribe.js";

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

// Every boss you've killed, each with its best-ilvl (current-gear) kill -- the pool
// pickBenchmarkKill picks the representative (median-parse) kill from, exactly like
// prescribe. Same characterEncounter reads the other cards make (cached -> ~free).
async function gatherKills(name, server, region, difficulty, specName) {
  const c = await characterZone(name, server, region, difficulty);
  const ranks = (c.zoneRankings.rankings || []).filter(
    (r) => (r.totalKills || 0) > 0 && r.rankPercent != null);
  const got = await mapLimit(ranks, 5, async (r) => {
    const er = await characterEncounter(name, server, region, r.encounter.id, difficulty);
    const best = bestRank(er && er.ranks, specName);
    return best ? {
      ilvl: best.bracketData || 0, boss: r.encounter, code: best.report.code,
      fight: best.report.fightID, startTime: best.startTime || 0,
      rankPercent: best.rankPercent, dur: best.duration || 0,
    } : null;
  });
  return got.filter(Boolean);
}

// Pure computation: your curve + the peer band over the benchmark kill, normalized to
// fight progress, plus the worst-dip window. Returns a `skip` marker (not null) for the
// "by design we don't chart this" cases so run() can explain rather than go silent.
export async function graphFindings(name, server, region, className, specName, difficulty) {
  // Support specs (Augmentation): personal damage isn't their lever (their value is
  // ally buffs), so a personal-DPS curve misleads. Suppress -- same rule the weak-window
  // lever uses.
  if (isSupport(specName)) return { skip: "support" };
  const kills = await gatherKills(name, server, region, difficulty, specName);
  if (!kills.length) return null;
  const bench = pickBenchmarkKill(kills);
  if (!bench) return null;
  const { code, fight, boss } = bench;
  const you = await playerMetrics(code, fight, name, specName, className);
  if (!you) return null;
  const yc = await dpsOverTime(code, fight, you.sourceID);
  if (!yc) return null;

  // The SAME ilvl-matched field every other comparison uses (shared selection -> the
  // per-peer reportCore reads dedupe with timeline/prescribe; only the graph query is new).
  const cands = await ilvlPeers(name, server, region, boss, difficulty, className, specName);
  const peers = await collectUpTo(cands, PEER_SAMPLE, 4, async (r) => {
    const m = await playerMetrics(r.report.code, r.report.fightID, r.name, specName, className);
    if (!m) return null;
    const cc = await dpsOverTime(r.report.code, r.report.fightID, m.sourceID);
    return cc ? { dps: cc.dps, phases: cc.phases, overall: m.dps } : null;
  });
  const cmp = buildCurveComparison(yc, peers);
  if (!cmp) return { skip: "fewpeers", boss: boss.name };

  // DIAGNOSE the dip so the advice is concrete (the user's two questions: am I idle, or
  // pressing the wrong things?). Re-read YOUR casts on the SAME kill (cached -- the
  // timeline already fetched them) and compare your cast rate DURING the dip window to
  // your whole-fight rate. Cast rate collapses -> you go passive there (movement/coast).
  // Cast rate holds but damage is down -> you keep pressing but your big cooldowns landed
  // ELSEWHERE (filler in the window) -- a cooldown-alignment problem, not idling.
  const w = cmp.worst;
  if (w && w.deficit >= DIP_FLOOR && !runIsHealer()) {
    try {
      const [fS, fE] = await fightWindow(code, fight);
      const durMs = fE - fS;
      const { casts } = await fightEvents(code, fight, you.sourceID, fS, fE);
      const ts = casts.map((e) => e.timestamp);
      const aMs = fS + (w.fracStart || 0) * durMs, bMs = fS + (w.fracEnd || 1) * durMs;
      const winMin = Math.max(0.05, (bMs - aMs) / 60000), fightMin = Math.max(0.05, durMs / 60000);
      const cpmWin = ts.filter((t) => t >= aMs && t <= bMs).length / winMin;
      const cpmAll = ts.length / fightMin;
      w.cpmRatio = cpmAll > 0 ? cpmWin / cpmAll : 1;
      w.cause = w.cpmRatio < 0.78 ? "idle" : "cooldown";
    } catch (e) { /* no cast data -> leave cause unset (run() degrades to a generic read) */ }
  }

  return {
    boss: boss.name, unit: metricUnit(), isHealer: runIsHealer(),
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
  if (w.cause === "idle") {
    return [finding(DIM.EXECUTION, INFO,
      `Your softest stretch is ${where} on ${d.boss} -- your ${unit} drops to ~${kfmt(w.youWindow)} vs your own ~${kfmt(w.youTypical)} the rest of the kill, and your cast rate falls to ${Math.round(100 * (w.cpmRatio || 0))}% of normal. That's the lost-GCD time above, in one window: keep your rotation going through the ${where} mechanics instead of coasting.`,
      "measured", KIND.PHASE_DIP)];
  }
  // cooldown / unknown-cause -> a real sized lever, framed against YOUR OWN typical.
  const drop = `your ${unit} drops to ~${kfmt(w.youWindow)} vs your own ~${kfmt(w.youTypical)} the rest of the kill`;
  const cd = w.cause === "cooldown"
    ? `${drop}, but your cast rate's normal -- your burst cooldowns are spent earlier and you run ${where} on filler. Hold/align a burst cooldown for ${where}.`
    : `${drop}. Line up your cooldowns and keep your uptime up through it.`;
  return [finding(DIM.EXECUTION, DPS(w.gainPct),
    `${where} on ${d.boss}: ${cd}`, "measured", KIND.PHASE_DIP)];
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

  // The dip is measured OWN-BASELINE: where YOUR output trails YOUR OWN typical, NOT the
  // field median. Field-relative is the high-percentile trap -- a player 45% ahead of the
  // field can be "under the field median" in one phase (they front-load) with nothing
  // gainable there; telling them to match the field contradicts their own headline. Own-
  // baseline is always gainable (you've demonstrably done better yourself this same kill)
  // and consistent for elite and average players alike. (Same principle as the rotation
  // weak-window lever.) The field band stays as the chart's visual context.
  const liveYou = you48.filter((_, g) => live[g]);
  const yourTypical = liveYou.length ? median(liveYou) : (median(you48) || 1);
  const W = Math.max(4, Math.round(N * 0.18));
  /** @type {{start:number,end:number,deficit:number,center:number,phase?:number,nPhases?:number,gainPct?:number,fracStart?:number,fracEnd?:number,cause?:string,cpmRatio?:number,youTypical?:number,youWindow?:number}|null} */
  let worst = null;
  for (let i = 0; i + W <= N; i++) {
    let sum = 0, n = 0;
    for (let g = i; g < i + W; g++) if (live[g]) { sum += (yourTypical - you48[g]) / yourTypical; n++; }
    if (n < W / 2) continue;                                  // mostly-intermission window -> skip
    const deficit = sum / n;                                  // avg fraction below YOUR typical
    if (!worst || deficit > worst.deficit) worst = { start: i, end: i + W, deficit, center: (i + W / 2) / N };
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

export async function run(log, name, server, region, className = "Monk", specName = "Brewmaster", difficulty = 5) {
  const unit = metricUnit();
  log("");
  log(`=== ${unit} over the fight: ${name} vs the ilvl-matched field ===`);
  let d;
  try { d = await graphFindings(name, server, region, className, specName, difficulty); }
  catch (e) { log(`  (couldn't build the curve: ${e.message || e})`); return; }
  if (!d) { log("  (no ranked kills with a peer field to chart.)"); return; }
  if (d.skip === "support") { log("  Support spec -- personal damage isn't the lever; see the Support buffs card for your ally value."); return; }
  if (d.skip === "fewpeers") { log(`  ${d.boss}: too few ilvl-matched peers loaded to draw a field band.`); return; }

  // Past the skip/null guards d is the full comparison object; cast once so the rich
  // fields (band %, worst, bounds) read cleanly (the union still carries the skip shapes).
  const g = /** @type {any} */ (d);
  if (typeof document !== "undefined") log(CHART_PREFIX + JSON.stringify(chartData(g)));
  else asciiChart(log, g);

  log("");
  log(`  ${g.boss} · your median kill vs ${g.peers} peers at your item level${g.aligned ? " · aligned by phase" : ""}.`);

  // Healers: HPS shape tracks INCOMING raid damage, not a rotation hole -- so don't
  // tell them to "push more HPS here". Show the curve, defer the real levers to Healing.
  if (g.isHealer) {
    log("  Your HPS curve tracks when the raid took damage (it's reactive), so the shape isn't a rotation hole. See the Healing card for what you control: overhealing and mana.");
    return;
  }

  // One human sentence on the shape, then the soft spot + what to do about it.
  if ((g.bandBelow || 0) >= 0.4) log("  You run under the field most of the kill — the gap is spread across the fight, not one spot.");
  else if ((g.bandAbove || 0) >= 0.5) log("  You're ahead of the field most of the kill. One soft spot:");
  else log("  You ride with the field most of the kill. Your soft spot:");

  // The dip is OWN-BASELINE (you vs your OWN typical) -- gainable and consistent even when
  // you're ahead of the field. The field band above is just the visual context.
  const w = g.worst;
  const kk = (n) => `${Math.round((n || 0) / 1000)}k`;
  if (w && w.deficit >= DIP_FLOOR) {
    const where = w.phase ? `Phase ${w.phase}` : w.center < 1 / 3 ? "your opener" : w.center < 2 / 3 ? "the middle" : "the execute";
    const drop = `${where}: your ${unit} drops to ~${kk(w.youWindow)} vs your own ~${kk(w.youTypical)} the rest of the kill`;
    if (w.cause === "idle") {
      log(`  -> ${drop}, and your cast rate falls to ${Math.round(100 * (w.cpmRatio || 0))}% of normal — you go quiet here.`);
      log(`     Keep your rotation going through ${where}'s movement/mechanics instead of coasting. (~${w.gainPct}% ${unit})`);
    } else if (w.cause === "cooldown") {
      log(`  -> ${drop}, but you keep pressing (cast rate normal) — your burst is spent earlier and you run ${where} on filler.`);
      log(`     Hold a burst cooldown for ${where}. (~${w.gainPct}% ${unit})`);
    } else {
      log(`  -> ${drop}. Line up your cooldowns and keep your uptime up through it. (~${w.gainPct}% ${unit})`);
    }
  } else {
    log("  -> No one stretch stands out — you hold your level across the kill.");
  }
}
