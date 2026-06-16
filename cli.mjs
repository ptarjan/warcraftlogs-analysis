#!/usr/bin/env node
// @ts-check
/**
 * Command-line runner for the analysis modules -- no Worker needed.
 *
 * The browser app routes through the Cloudflare Worker (to hide the secret and
 * dodge CORS); under Node neither applies, so wcl.js talks straight to WCL with
 * your credentials. This driver just shims the one browser global the analysis
 * modules touch (localStorage, used by gear.js for its item-stat cache) and
 * calls each module's run() with console.log as the line emitter.
 *
 * Credentials: WCL_CLIENT_ID / WCL_CLIENT_SECRET via env, .env, or
 * worker/.dev.vars (all gitignored).
 *
 * Usage:
 *   node cli.mjs "Hadryan" proudmoore US
 *   node cli.mjs "Hadryan" proudmoore US --only prescribe
 *   node cli.mjs "Name" server EU --class Monk --spec Brewmaster --difficulty 4
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { setupNodeCaches, CACHE_DIR } from "./cli-common.mjs";

// The card wiring as PURE DATA so it can be verified without running anything.
// Each spec names the module + exported method the CLI invokes and how to build
// its argument list from the resolved params `p`. Order = print order.
// `cli.test.mjs` walks this list to assert every (module, method) actually
// resolves -- that's the guard that catches a rename like analyze->overview or
// gear.audit->gear.run before it ships (the bug this list now prevents).
export const SECTION_SPECS = [
  { key: "overview", title: "OVERVIEW & ITEM-LEVEL-MATCHED COMPARISON",
    module: "./docs/overview.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "timeline", title: "TIMELINE DIAGNOSIS",
    module: "./docs/timeline.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "rotation", title: "ROTATION: OPENER & PRIORITY",
    module: "./docs/rotation.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "healing", title: "HEALING EFFICIENCY (healers only)",
    module: "./docs/healing.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "support", title: "SUPPORT BUFFS (support specs only)",
    module: "./docs/support.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "talents", title: "TALENTS vs THE FIELD",
    module: "./docs/talents.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "chasing99", title: "CHASING 99: YOU vs THE TOP PARSES",
    module: "./docs/topparse.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "gear", title: "GEAR AUDIT",
    module: "./docs/gear.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty, p.priority] },
  { key: "prescribe", title: "PRESCRIPTION",
    module: "./docs/prescribe.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty, p.priority] },
];

// Import a spec's module, resolved relative to THIS file (so the test can load
// it from test/ too). Returns the module namespace.
export const loadSectionModule = (spec) => import(new URL(spec.module, import.meta.url).href);

// Attribute a fetching run's point spend to its requests + report-units, append a
// sample, and (across >=2 runs) report which ratio is STABLE -- the billing basis.
// Constant points/request => FLAT (batching cuts the points budget); constant
// points/unit => COMPLEXITY-scaled (batching saves requests/latency, not points).
// This rides the loop's existing spend, so no separate probe run is needed.
async function summarizeBilling(rateLimit, getRunStats, character, startSpent) {
  const rl = await rateLimit();
  const endSpent = rl ? rl.spent : null;
  const { requests, units } = getRunStats();
  if (startSpent == null || endSpent == null) { console.log("[billing] could not read pointsSpentThisHour -- skipping."); return; }
  const points = endSpent - startSpent;
  if (!(requests > 0) || !(points > 0)) { console.log(`[billing] no measurable spend (requests=${requests}, points=${points}) -- run was ~fully cached.`); return; }
  const perReq = points / requests, perUnit = points / units;
  console.log(`[billing] this run: ${points} pts over ${requests} requests / ${units} report-units  (${perReq.toFixed(1)} pts/req, ${perUnit.toFixed(1)} pts/unit)`);
  const file = path.join(CACHE_DIR, "billing-samples.jsonl");
  const sample = { at: new Date().toISOString(), character, requests, units, points, perReq, perUnit };
  let samples = [];
  try { samples = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ }
  samples.push(sample);
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.appendFileSync(file, JSON.stringify(sample) + "\n"); } catch (e) { console.error(`[billing] could not save sample: ${e.message || e}`); }
  if (samples.length < 2) { console.log(`[billing] 1 sample so far -- a few more --allow-fetch characters resolve the basis (saved to ${file}).`); return; }
  // Whichever ratio varies LESS across runs (with differing units/request mixes) is
  // the billing basis. CV = stddev/mean; lower = more stable.
  const cv = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); return m ? sd / m : Infinity; };
  const cvReq = cv(samples.map((s) => s.perReq)), cvUnit = cv(samples.map((s) => s.perUnit));
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const basis = cvReq < cvUnit
    ? `FLAT per request (pts/req CV ${pct(cvReq)} < pts/unit CV ${pct(cvUnit)}) -- batching IS a points win`
    : `COMPLEXITY-scaled (pts/unit CV ${pct(cvUnit)} < pts/req CV ${pct(cvReq)}) -- batching saves requests, NOT points`;
  console.log(`[billing] across ${samples.length} runs: ${basis}`);
}

// Persist WCL GraphQL results to disk between runs (wcl.js, Node-only) so
// iterating on one character doesn't re-spend points and trip WCL's per-IP 429
// throttle. Must be set before importing anything that pulls in wcl.js. Point it
// at the SHARED home cache (next to the item cache below) so every git worktree
// reuses the same GraphQL results -- otherwise each worktree kept its own
// repo-root cache and re-spent points the others had already paid for.
async function main() {
// WCL disk cache + file-backed localStorage shim, shared across git worktrees
// (see cli-common.mjs). Must run before importing anything that pulls in wcl.js.
setupNodeCaches();

// --- args ---
const argv = process.argv.slice(2);
const positional = [];
const opt = { only: "" }; // class/spec/difficulty/priority are auto-detected unless given
// Valueless boolean flags (must NOT consume the next arg, or they'd eat a positional).
const BOOL_FLAGS = new Set(["allow-fetch", "cache-only"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { const k = a.slice(2); opt[k] = BOOL_FLAGS.has(k) ? true : argv[++i]; }
  else positional.push(a);
}
// Fetching the WCL network (= spending the shared hourly point budget) is OPT-IN:
// pass --allow-fetch to permit it; otherwise this run is cache-only and an uncached
// query fails fast (no accidental budget spend). --cache-only forces read-only.
// --allow-fetch is only HONORED after the budget gate below clears (reserve + lock).
if (opt["cache-only"]) process.env.WCL_CACHE_ONLY = "1";
const [name, server, region] = positional;
if (!name || !server || !region) {
  console.error("usage: node cli.mjs <name> <server> <region> " +
    "[--class Monk] [--spec Brewmaster] [--difficulty 5] [--priority crit] " +
    "[--only overview,timeline,gear,prescribe] [--allow-fetch] [--cache-only]\n" +
    "(class/spec/difficulty/priority are auto-detected from your logs if omitted;\n" +
    " runs are CACHE-ONLY by default -- add --allow-fetch to pull from WCL, which spends your hourly point budget)");
  process.exit(1);
}
const only = opt.only ? new Set(opt.only.split(",").map((s) => s.trim())) : null;

// --- run ---
const { detectContext, detectPriority, DIFFICULTY, setRunContext, metricUnit } = await import("./docs/core.js");
// Learn WCL's point-reset clock up front (one cheap query, while still under
// budget) so if we exhaust the shared budget mid-run the error can say WHEN it
// resets ("try again in ~N min") instead of a vague "try again shortly".
const { primeRateReset, acquireFetchGate, rateLimit, resetRunStats, getRunStats } = await import("./docs/wcl.js");

const log = (line = "") => console.log(line);

// Budget gate: --allow-fetch is a REQUEST to spend the shared hourly budget, but we
// only honor it if a reserve of points remains AND no other run holds the fetch lock
// (single-writer). Otherwise stay cache-only -- never overspend, never double-fetch.
let fetching = false;
if (opt["allow-fetch"] && !opt["cache-only"]) {
  const gate = await acquireFetchGate();
  if (gate.ok) { process.env.WCL_ALLOW_FETCH = "1"; fetching = true; log(`[budget] fetching enabled (~${Math.round(gate.remaining ?? 0)} WCL pts available).`); }
  else log(`[budget] NOT fetching: ${gate.reason}. Running cache-only.`);
}
// Learn WCL's point-reset clock up front so a mid-run 429 can say WHEN it resets.
await primeRateReset();

// Billing diagnostics: snapshot points spent + zero the request/unit counters BEFORE
// the run, so the whole run's spend (detection included) is attributed. Only meaningful
// when actually fetching -- a cache-only run spends nothing. See `summarizeBilling`.
let startSpent = null;
if (fetching) { const rl = await rateLimit(); startSpent = rl ? rl.spent : null; resetRunStats(); }

// Auto-detect class / spec / difficulty / priority from the character's own
// logs (mirrors the browser app). NEVER assume a class -- the analysis filters
// WCL tables by sourceClass, so a wrong class silently empties every section.
// CLI flags override individual detected fields.
let cls = opt.class, spec = opt.spec, priority = opt.priority;
let difficulty = opt.difficulty != null ? parseInt(opt.difficulty, 10) : undefined;
if (!cls || !spec || difficulty === undefined || !priority) {
  log("Detecting class, spec, and difficulty…");
  let ctx;
  try {
    ctx = await detectContext(name, server, region);
  } catch (e) {
    // No usable logs (character/server typo, never uploaded, private logs, …).
    // Print the one-line reason, not a stack trace, and bail before any section.
    console.error(`[error] ${e.message || e}`);
    process.exit(1);
  }
  cls = cls || ctx.className;
  spec = spec || ctx.specName;
  if (difficulty === undefined) difficulty = ctx.difficulty;
  // Healers are measured on HEALING, everyone else on DAMAGE. Set BEFORE
  // detectPriority so even the stat-priority sample is drawn from the right
  // (healing- vs damage-ranked) peers.
  setRunContext(cls, spec);                     // metric (HPS for healers) + support framing, atomically
  if (!priority) priority = await detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
  log(`Detected: ${spec} ${cls} · ${DIFFICULTY[difficulty] || difficulty} · gear priority ${priority} · optimizing ${metricUnit()}`);
}
// Cover the all-flags path (detection skipped): context must match the spec. (Atomic
// setRunContext also sets the support flag here -- the old setRunMetric-only line left
// an Augmentation analyzed via explicit flags mis-framed as personal DPS.)
setRunContext(cls, spec);
const p = { name, server, region, cls, spec, difficulty, priority };

log(`=== ${p.name}-${p.server} (${p.region}) | ${p.spec} ${p.cls} | ${DIFFICULTY[p.difficulty] || p.difficulty} ===`);
// Run the SUPPORTING sections CONCURRENTLY (mirrors the browser app.js, which fires
// them all at once -- the analysis modules are built for it). Each buffers its own
// output and we print the buffers in SECTION_SPECS order on completion, so the
// transcript is byte-identical to the old serial run -- only the wall-clock drops
// (overlapping fetches coalesce via gql()'s inflight/batcher). prescribe runs LAST
// (cache now warm) and streams live, since it's the payoff. Each section catches its
// own errors into its buffer, so one failure never sinks the others.
const selected = SECTION_SPECS.filter((s) => !only || only.has(s.key));
const supporting = selected.filter((s) => s.key !== "prescribe");
const header = (title) => "\n" + "#".repeat(70) + `\n# ${title}\n` + "#".repeat(70);
const buffers = await Promise.all(supporting.map(async (spec) => {
  const buf = [];
  try {
    const mod = await loadSectionModule(spec);
    await mod[spec.method]((line = "") => buf.push(line), ...spec.args(p));
  } catch (e) { buf.push(`[error] ${spec.title}: ${e.message || e}`); }
  return buf;
}));
supporting.forEach((spec, i) => { log(header(spec.title)); for (const line of buffers[i]) log(line); });
const prescribeSpec = selected.find((s) => s.key === "prescribe");
if (prescribeSpec) {
  log(header(prescribeSpec.title));
  try {
    const mod = await loadSectionModule(prescribeSpec);
    await mod[prescribeSpec.method](log, ...prescribeSpec.args(p));
  } catch (e) { log(`[error] ${prescribeSpec.title}: ${e.message || e}`); }
}

// Billing diagnostics: attribute this run's point spend to its requests/units and
// accumulate across runs so the flat-vs-complexity basis emerges for free (see
// summarizeBilling). Only when we actually fetched -- a cache-only run spends nothing.
if (fetching) await summarizeBilling(rateLimit, getRunStats, `${p.name}-${p.server} (${p.region})`, startSpent);
}

// Only run when invoked directly (node cli.mjs ...); stays inert on import so
// cli.test.mjs can introspect SECTION_SPECS without executing the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
