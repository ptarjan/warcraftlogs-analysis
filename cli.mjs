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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  { key: "talents", title: "TALENTS vs THE FIELD",
    module: "./docs/talents.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "chasing99", title: "CHASING 99: YOU vs THE TOP PARSES",
    module: "./docs/topparse.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty] },
  { key: "gear", title: "GEAR AUDIT",
    module: "./docs/gear.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.difficulty, p.cls, p.spec, p.priority] },
  { key: "prescribe", title: "PRESCRIPTION",
    module: "./docs/prescribe.js", method: "run",
    args: (p) => [p.name, p.server, p.region, p.cls, p.spec, p.difficulty, p.priority] },
];

// Import a spec's module, resolved relative to THIS file (so the test can load
// it from test/ too). Returns the module namespace.
export const loadSectionModule = (spec) => import(new URL(spec.module, import.meta.url).href);

// Persist WCL GraphQL results to disk between runs (wcl.js, Node-only) so
// iterating on one character doesn't re-spend points and trip WCL's per-IP 429
// throttle. Must be set before importing anything that pulls in wcl.js. Point it
// at the SHARED home cache (next to the item cache below) so every git worktree
// reuses the same GraphQL results -- otherwise each worktree kept its own
// repo-root cache and re-spent points the others had already paid for.
async function main() {
const CACHE_DIR = path.join(os.homedir(), ".cache", "warcraftlogs-analysis");
process.env.WCL_GQL_CACHE = "1";
process.env.WCL_GQL_CACHE_FILE = process.env.WCL_GQL_CACHE_FILE || path.join(CACHE_DIR, "gql-cache.json");

// --- file-backed localStorage shim (persists gear.js's item-stat/instance cache
// between runs). Shared across git worktrees -- one cache in the home dir, like
// the GraphQL cache -- so parallel worktrees reuse each other's Wowhead lookups.
const CACHE_FILE = path.join(CACHE_DIR, "item-cache.json");
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
let _store = {};
try { _store = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* none yet */ }
let _saveTimer = null;
const _save = () => {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    // Merge with concurrent worktrees' writes, then atomic rename (temp+rename).
    try {
      let merged = _store;
      try { merged = { ...JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")), ..._store }; } catch { /* ours */ }
      _store = merged;
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(merged));
      fs.renameSync(tmp, CACHE_FILE);
    } catch {}
  }, 200);
};
globalThis.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); _save(); },
  removeItem: (k) => { delete _store[k]; _save(); },
  clear: () => { _store = {}; _save(); },
  key: (i) => Object.keys(_store)[i] ?? null,
  get length() { return Object.keys(_store).length; },
};

// --- args ---
const argv = process.argv.slice(2);
const positional = [];
const opt = { only: "" }; // class/spec/difficulty/priority are auto-detected unless given
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
  else positional.push(a);
}
const [name, server, region] = positional;
if (!name || !server || !region) {
  console.error("usage: node cli.mjs <name> <server> <region> " +
    "[--class Monk] [--spec Brewmaster] [--difficulty 5] [--priority crit] " +
    "[--only overview,timeline,gear,prescribe]\n" +
    "(class/spec/difficulty/priority are auto-detected from your logs if omitted)");
  process.exit(1);
}
const only = opt.only ? new Set(opt.only.split(",").map((s) => s.trim())) : null;

// --- run ---
const { detectContext, detectPriority, DIFFICULTY, metricForSpec, setRunMetric, metricUnit } = await import("./docs/core.js");
// Learn WCL's point-reset clock up front (one cheap query, while still under
// budget) so if we exhaust the shared budget mid-run the error can say WHEN it
// resets ("try again in ~N min") instead of a vague "try again shortly".
const { primeRateReset } = await import("./docs/wcl.js");
await primeRateReset();

const log = (line = "") => console.log(line);

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
  setRunMetric(metricForSpec(cls, spec));
  if (!priority) priority = await detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
  log(`Detected: ${spec} ${cls} · ${DIFFICULTY[difficulty] || difficulty} · gear priority ${priority} · optimizing ${metricUnit()}`);
}
// Cover the all-flags path (detection skipped): metric must match the spec.
setRunMetric(metricForSpec(cls, spec));
const p = { name, server, region, cls, spec, difficulty, priority };

log(`=== ${p.name}-${p.server} (${p.region}) | ${p.spec} ${p.cls} | difficulty ${p.difficulty} ===`);
for (const spec of SECTION_SPECS) {
  if (only && !only.has(spec.key)) continue;
  log("\n" + "#".repeat(70) + `\n# ${spec.title}\n` + "#".repeat(70));
  try {
    const mod = await loadSectionModule(spec);
    await mod[spec.method](log, ...spec.args(p));
  } catch (e) { log(`[error] ${spec.title}: ${e.message || e}`); }
}
}

// Only run when invoked directly (node cli.mjs ...); stays inert on import so
// cli.test.mjs can introspect SECTION_SPECS without executing the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
