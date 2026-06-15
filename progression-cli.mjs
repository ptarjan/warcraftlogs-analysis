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
import { pathToFileURL } from "node:url";
import { setupNodeCaches } from "./cli-common.mjs";

async function main() {
  // WCL disk cache + file-backed localStorage shim, shared across worktrees (and now
  // persisted -- the old inline shim here didn't save Wowhead lookups). See cli-common.mjs.
  setupNodeCaches();

  const argv = process.argv.slice(2);
  const positional = [];
  const opt = {};
  const BOOL_FLAGS = new Set(["allow-fetch", "cache-only"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); opt[k] = BOOL_FLAGS.has(k) ? true : argv[++i]; }
    else positional.push(a);
  }
  // Cache-only by default; --allow-fetch opts in (honored only if the gate clears).
  if (opt["cache-only"]) process.env.WCL_CACHE_ONLY = "1";
  if (!positional[0]) {
    console.error('usage: node progression-cli.mjs <report-url-or-code> [--enc <encounterId>] [--allow-fetch]\n' +
      ' (cache-only by default -- add --allow-fetch to pull from WCL, which spends your hourly point budget)');
    process.exit(1);
  }

  const { parseReportRef } = await import("./docs/core.js");
  const { primeRateReset, acquireFetchGate } = await import("./docs/wcl.js");
  const progression = await import("./docs/progression.js");
  if (opt["allow-fetch"] && !opt["cache-only"]) {
    const gate = await acquireFetchGate();
    if (gate.ok) { process.env.WCL_ALLOW_FETCH = "1"; console.log(`[budget] fetching enabled (~${Math.round(gate.remaining)} WCL pts available).`); }
    else console.log(`[budget] NOT fetching: ${gate.reason}. Running cache-only.`);
  }
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
