#!/usr/bin/env node
/**
 * Command-line runner for the analysis modules -- no Worker needed.
 *
 * The browser app routes through the Cloudflare Worker (to hide the secret and
 * dodge CORS); under Node neither applies, so wcl.js talks straight to WCL with
 * your credentials. This driver just shims the one browser global the analysis
 * modules touch (localStorage, used by gear.js for its item-stat cache) and
 * calls each module's run()/audit() with console.log as the line emitter.
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

// Persist WCL GraphQL results to disk between runs (wcl.js, Node-only) so
// iterating on one character doesn't re-spend points and trip WCL's per-IP 429
// throttle. Must be set before importing anything that pulls in wcl.js.
process.env.WCL_GQL_CACHE = "1";

// --- file-backed localStorage shim (persists gear.js's item-stat/instance cache
// between runs). Shared across git worktrees -- one cache in the home dir, like
// the GraphQL cache -- so parallel worktrees reuse each other's Wowhead lookups.
const CACHE_DIR = path.join(os.homedir(), ".cache", "warcraftlogs-analysis");
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
    "[--only overview,diagnose,gear,prescribe]\n" +
    "(class/spec/difficulty/priority are auto-detected from your logs if omitted)");
  process.exit(1);
}
const only = opt.only ? new Set(opt.only.split(",").map((s) => s.trim())) : null;

// --- run ---
const { detectContext, detectPriority, DIFFICULTY } = await import("./docs/core.js");
const analyze = await import("./docs/analyze.js");
const diagnose = await import("./docs/diagnose.js");
const rotation = await import("./docs/rotation.js");
const gear = await import("./docs/gear.js");
const prescribe = await import("./docs/prescribe.js");

const log = (line = "") => console.log(line);

// Auto-detect class / spec / difficulty / priority from the character's own
// logs (mirrors the browser app). NEVER assume a class -- the analysis filters
// WCL tables by sourceClass, so a wrong class silently empties every section.
// CLI flags override individual detected fields.
let cls = opt.class, spec = opt.spec, priority = opt.priority;
let difficulty = opt.difficulty != null ? parseInt(opt.difficulty, 10) : undefined;
if (!cls || !spec || difficulty === undefined || !priority) {
  log("Detecting class, spec, and difficulty…");
  const ctx = await detectContext(name, server, region);
  cls = cls || ctx.className;
  spec = spec || ctx.specName;
  if (difficulty === undefined) difficulty = ctx.difficulty;
  if (!priority) priority = await detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
  log(`Detected: ${spec} ${cls} · ${DIFFICULTY[difficulty] || difficulty} · gear priority ${priority}`);
}
const p = { name, server, region, cls, spec, difficulty, priority };
const SECTIONS = {
  overview: ["OVERVIEW & ITEM-LEVEL-MATCHED COMPARISON",
    () => analyze.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  diagnose: ["TIMELINE DIAGNOSIS",
    () => diagnose.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  rotation: ["ROTATION: OPENER & PRIORITY",
    () => rotation.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  gear: ["GEAR AUDIT",
    () => gear.audit(log, p.name, p.server, p.region, p.difficulty, p.cls, p.spec, p.priority)],
  prescribe: ["PRESCRIPTION",
    () => prescribe.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
};

log(`=== ${p.name}-${p.server} (${p.region}) | ${p.spec} ${p.cls} | difficulty ${p.difficulty} ===`);
for (const key of Object.keys(SECTIONS)) {
  if (only && !only.has(key)) continue;
  const [title, fn] = SECTIONS[key];
  log("\n" + "#".repeat(70) + `\n# ${title}\n` + "#".repeat(70));
  try { await fn(); }
  catch (e) { log(`[error] ${title}: ${e.message || e}`); }
}
