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
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- file-backed localStorage shim (persists gear.js's item cache between runs)
const dir = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(dir, ".cli-cache.json");
let _store = {};
try { _store = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* none yet */ }
let _saveTimer = null;
const _save = () => {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(_store)); } catch {} }, 200);
};
globalThis.localStorage = {
  getItem: (k) => (k in _store ? _store[k] : null),
  setItem: (k, v) => { _store[k] = String(v); _save(); },
  removeItem: (k) => { delete _store[k]; _save(); },
};

// --- args ---
const argv = process.argv.slice(2);
const positional = [];
const opt = { class: "Monk", spec: "Brewmaster", difficulty: "5", priority: "crit", only: "" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
  else positional.push(a);
}
const [name, server, region] = positional;
if (!name || !server || !region) {
  console.error("usage: node cli.mjs <name> <server> <region> " +
    "[--class Monk] [--spec Brewmaster] [--difficulty 5] [--priority crit] " +
    "[--only overview,diagnose,gear,prescribe]");
  process.exit(1);
}
const p = {
  name, server, region,
  cls: opt.class, spec: opt.spec,
  difficulty: parseInt(opt.difficulty, 10), priority: opt.priority,
};
const only = opt.only ? new Set(opt.only.split(",").map((s) => s.trim())) : null;

// --- run ---
const analyze = await import("./docs/analyze.js");
const diagnose = await import("./docs/diagnose.js");
const gear = await import("./docs/gear.js");
const prescribe = await import("./docs/prescribe.js");

const log = (line = "") => console.log(line);
const SECTIONS = {
  overview: ["OVERVIEW & ITEM-LEVEL-MATCHED COMPARISON",
    () => analyze.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  diagnose: ["TIMELINE DIAGNOSIS",
    () => diagnose.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
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
