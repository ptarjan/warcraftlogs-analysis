#!/usr/bin/env node
// @ts-check
/**
 * Command-line runner for the RAID PROGRESSION analyzer -- the group "what to
 * change to kill the boss" flow (see docs/progression.js), for backtesting a
 * full night of pulls from the terminal.
 *
 * Usage:
 *   node progression-cli.mjs "https://www.warcraftlogs.com/reports/aBcD1234"
 *   node progression-cli.mjs aBcD1234 --enc 2902     # pin a specific encounter id
 *
 * Credentials: WCL_CLIENT_ID / WCL_CLIENT_SECRET via env, .env, or worker/.dev.vars.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const CACHE_DIR = path.join(os.homedir(), ".cache", "warcraftlogs-analysis");
  process.env.WCL_GQL_CACHE = "1";
  process.env.WCL_GQL_CACHE_FILE = process.env.WCL_GQL_CACHE_FILE || path.join(CACHE_DIR, "gql-cache.json");

  // Minimal file-backed localStorage shim (Wowhead item cache), matching cli.mjs.
  const CACHE_FILE = path.join(CACHE_DIR, "item-cache.json");
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
  let _store = {};
  try { _store = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { /* none yet */ }
  globalThis.localStorage = {
    getItem: (k) => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
  };

  const argv = process.argv.slice(2);
  const positional = [];
  const opt = {};
  const BOOL_FLAGS = new Set(["allow-fetch", "cache-only"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); opt[k] = BOOL_FLAGS.has(k) ? true : argv[++i]; }
    else positional.push(a);
  }
  // Cache-only by default; --allow-fetch opts in to spending the WCL point budget.
  if (opt["allow-fetch"]) process.env.WCL_ALLOW_FETCH = "1";
  if (opt["cache-only"]) process.env.WCL_CACHE_ONLY = "1";
  if (!positional[0]) {
    console.error('usage: node progression-cli.mjs <report-url-or-code> [--enc <encounterId>] [--allow-fetch]\n' +
      ' (cache-only by default -- add --allow-fetch to pull from WCL, which spends your hourly point budget)');
    process.exit(1);
  }

  const { parseReportRef } = await import("./docs/core.js");
  const { primeRateReset } = await import("./docs/wcl.js");
  const progression = await import("./docs/progression.js");
  await primeRateReset();

  const { code } = parseReportRef(positional[0]);
  if (!code) { console.error("[error] couldn't parse a report code from " + positional[0]); process.exit(1); }
  const encounterId = opt.enc ? parseInt(opt.enc, 10) : null;
  const log = (line = "") => console.log(line);
  try {
    const r = await progression.run(log, { code }, { encounterId });
    if (!r) process.exit(1);
  } catch (e) { console.error(`[error] ${e.message || e}`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
