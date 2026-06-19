// @ts-check
// Visual throughput-over-time card: YOUR damage (or healing) curve over your
// benchmark kill, overlaid on the ilvl-matched field's BAND (median + 25-75%
// interquartile), plus a read on WHERE in the fight you can gain. The picture the
// text Timeline diagnosis can't draw; it points at the window, the Timeline /
// Rotation cards size the lever. Same compute/render split as every other module.
import {
  characterZone, characterEncounter, playerMetrics, ilvlPeers, PEER_SAMPLE,
  median, collectUpTo, mapLimit, bestRank, dpsOverTime, metricUnit, runIsHealer, isSupport,
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

// Resample EACH phase of a curve to its allotted width and concatenate -> a curve whose
// phase boundaries align with every other curve aligned to the same widths.
function alignCurve(dps, fracs, widths) {
  const out = [];
  for (let p = 0; p < widths.length; p++) {
    const a = fracs[p], b = p + 1 < fracs.length ? fracs[p + 1] : 1;
    const w = widths[p];
    for (let k = 0; k < w; k++) out.push(at(dps, w === 1 ? (a + b) / 2 : a + (b - a) * (k / (w - 1))));
  }
  return out;
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
  return {
    boss: boss.name, unit: metricUnit(), isHealer: runIsHealer(),
    ...cmp, yourOverall: you.dps, peerOverall: median(peers.map((p) => p.overall)), peers: peers.length,
  };
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
  let you48, peer48, bounds = [];
  if (aligned) {
    const pool = peers.filter((p) => (p.phases || [0]).length === refP);
    const widths = phaseWidths([yc.phases, ...pool.map((p) => p.phases)], G);
    you48 = alignCurve(yc.dps, yc.phases, widths);
    peer48 = pool.map((p) => alignCurve(p.dps, p.phases, widths));
    // grid index where each phase (2..P) begins -> chart dividers + phase labels
    let acc = 0;
    for (let p = 0; p < widths.length - 1; p++) { acc += widths[p]; bounds.push(acc); }
  } else {
    you48 = resample(yc.dps, G);
    peer48 = peers.map((p) => resample(p.dps, G));
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

  // Where you sit relative to the band, and the worst contiguous dip (~18% of the fight)
  // by RELATIVE deficit vs the field median -- the single window most worth attacking.
  let below = 0, above = 0;
  for (let g = 0; g < N; g++) {
    if (!live[g]) continue;
    if (you48[g] < plo[g]) below++; else if (you48[g] > phi[g]) above++;
  }
  const W = Math.max(4, Math.round(N * 0.18));
  /** @type {{start:number,end:number,deficit:number,center:number,phase?:number,nPhases?:number}|null} */
  let worst = null;
  for (let i = 0; i + W <= N; i++) {
    let sum = 0, n = 0;
    for (let g = i; g < i + W; g++) if (live[g] && pmed[g] > 0) { sum += (pmed[g] - you48[g]) / pmed[g]; n++; }
    if (n < W / 2) continue;                                  // mostly-intermission window -> skip
    const deficit = sum / n;
    if (!worst || deficit > worst.deficit) worst = { start: i, end: i + W, deficit, center: (i + W / 2) / N };
  }
  // Which phase the dip falls in (aligned runs only) -- a far more useful pointer than
  // "late in the fight": bounds[] are the grid indices where phases 2..P begin.
  if (worst && bounds.length) {
    const c = (worst.start + worst.end) / 2;
    worst.phase = bounds.filter((b) => b <= c).length + 1;     // 1-based phase number
    worst.nPhases = bounds.length + 1;
  }

  return {
    n: N, you: you48, pmed, plo, phi, worst, bounds, aligned,
    bandBelow: below / liveN, bandAbove: above / liveN, bandIn: (liveN - below - above) / liveN,
  };
}

// Class/role-agnostic "how" for a dip, keyed by where in the fight it lands.
const HOW = {
  opener: "ramp on the pull -- get your opener cooldowns out immediately (pre-cast where you can) and commit burst from the first GCD instead of easing in.",
  "mid-fight": "a mid-fight sag is usually a cooldown left waiting or movement/mechanic downtime -- use cooldowns the moment they're up and cut dead time in that window.",
  "execute (late)": "the field pushes harder late -- line up a cooldown for the end and keep pressing once the boss is low instead of coasting to the kill.",
};

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
  const frame = g.aligned
    ? `aligned by PHASE (${(g.bounds.length + 1)} phases, boundaries matched across kills so a faster phase doesn't smear the comparison)`
    : "normalized to fight progress";
  log(`  ${g.boss} -- your benchmark kill, ${unit} over the fight vs the field (line = median, shaded = 25-75%), ${frame} over ${g.peers} peers.`);

  // Healers: HPS shape tracks INCOMING raid damage, not a rotation hole -- so don't
  // tell them to "push more HPS here". Show the curve, defer the real levers to Healing.
  if (g.isHealer) {
    log("  -> HPS over time mostly mirrors when the raid took damage (reactive), so the shape isn't a rotation gap to close. See the Healing efficiency card for what you control (overhealing, mana).");
    return;
  }

  const pct = (x) => Math.round(100 * (x || 0));
  if ((g.bandAbove || 0) >= 0.5) {
    log(`  -> You track at or above the field for most of the fight (above the band ${pct(g.bandAbove)}% of it) -- strong. Your softest RELATIVE stretch is below.`);
  } else if ((g.bandBelow || 0) >= 0.4) {
    log(`  -> You run below the field band for ${pct(g.bandBelow)}% of the fight -- the gap is spread across the kill, not one moment.`);
  } else {
    log(`  -> You mostly track inside the field band (${pct(g.bandIn)}% of the fight) -- close to the field, dipping below in spots.`);
  }

  const w = g.worst, dn = g.n;
  if (w && w.deficit >= DIP_FLOOR) {
    const a = Math.round((100 * w.start) / dn), b = Math.round((100 * w.end) / dn);
    const where = w.center < 1 / 3 ? "opener" : w.center < 2 / 3 ? "mid-fight" : "execute (late)";
    const loc = w.phase ? `Phase ${w.phase} of ${w.nPhases}` : `~${a}-${b}% in (${where})`;
    log(`  -> Biggest dip: ${loc}, ~${Math.round(100 * w.deficit)}% under the field median there.`);
    log(`     How: ${HOW[where]}`);
  } else {
    log("  -> No single window stands out -- your curve mostly mirrors the field's shape; the gap (if any) is overall throughput, not one stretch.");
  }
  log("");
  log("  This card is the picture; the Timeline and Rotation cards size the levers behind these dips (lost GCDs, cooldown use, which buttons and when).");
}
