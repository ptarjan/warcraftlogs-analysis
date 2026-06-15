#!/usr/bin/env node
// @ts-check
/**
 * Billing probe: does WCL bill ~flat PER REQUEST, or scale with query COMPLEXITY?
 *
 * The whole auto-batcher (wcl.js) assumes flat-per-request -- combining N reports
 * into one POST is only a POINTS win if that holds. This settles it empirically by
 * running the SAME N report reads two ways (N separate vs 1 combined) and reading
 * WCL's own pointsSpentThisHour around each. See wcl.js `probeBilling`.
 *
 *   node probe-billing.mjs <name> <server> <region> --allow-fetch [--n 4]
 *
 * Spends a small slice of budget (2N report reads + a few rateLimit reads). Run it
 * from the roster-review loop, which is the sanctioned budget-spender.
 */
import fs from "node:fs";
import path from "node:path";
import { setupNodeCaches, CACHE_DIR } from "./cli-common.mjs";

async function main() {
  setupNodeCaches();
  const argv = process.argv.slice(2);
  const positional = [];
  const opt = {};
  const BOOL = new Set(["allow-fetch", "cache-only"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); opt[k] = BOOL.has(k) ? true : argv[++i]; }
    else positional.push(a);
  }
  const [name, server, region] = positional;
  if (!name || !server || !region) {
    console.error("usage: node probe-billing.mjs <name> <server> <region> --allow-fetch [--n 4]");
    process.exit(1);
  }
  const n = Math.max(2, parseInt(opt.n || "4", 10));

  const { acquireFetchGate, probeBilling, primeRateReset } = await import("./docs/wcl.js");
  const { detectContext, characterEncounter, _reportCoreQuery } = await import("./docs/core.js");

  // A probe is a deliberate spend -- require --allow-fetch and clear the same budget
  // gate (reserve + single-writer lock) as a real run, so it never overspends or
  // races another fetcher.
  if (!opt["allow-fetch"]) { console.error("[probe] refusing to spend budget without --allow-fetch"); process.exit(1); }
  const gate = await acquireFetchGate();
  if (!gate.ok) { console.error(`[probe] NOT fetching: ${gate.reason}`); process.exit(1); }
  process.env.WCL_ALLOW_FETCH = "1";
  await primeRateReset();

  // Find N distinct (report, fight) pairs from the character's own kills -- valid
  // reportCore queries, no synthetic data, built via the SAME frozen builder the
  // analysis uses (so we measure exactly the request shape a real run issues).
  const ctx = await detectContext(name, server, region);
  const er = await characterEncounter(name, server, region, ctx.killed[0].encounter.id, ctx.difficulty);
  const seen = new Set();
  const pairs = [];
  for (const rk of (er && er.ranks) || []) {
    const key = `${rk.report.code}:${rk.report.fightID}`;
    if (seen.has(key)) continue;
    seen.add(key); pairs.push(rk);
    if (pairs.length >= n) break;
  }
  if (pairs.length < 2) { console.error(`[probe] need >=2 distinct kills of ${ctx.killed[0].encounter.name}; found ${pairs.length}`); process.exit(1); }
  const queries = pairs.map((rk) => _reportCoreQuery(rk.report.code, rk.report.fightID));

  console.log(`[probe] ${name}-${server} (${region}): measuring ${queries.length} reportCore reads, separate vs combined…`);
  const res = await probeBilling(queries);
  if (!res.ok) { console.error(`[probe] ${res.reason}`); process.exit(1); }
  console.log(`[probe] ${res.n} separate requests cost ${res.sepCost} pts (${res.perReqSeparate.toFixed(1)}/req)`);
  console.log(`[probe] 1 combined request cost ${res.combCost} pts`);
  console.log(`[probe] VERDICT: ${res.verdict}`);

  // Persist the verdict so it OUTLIVES this process -- stdout evaporates, and the
  // session that acts on this (raise _BATCH_MAX / fan out, or don't) is almost
  // certainly a different one. Any future run reads this file to learn the answer
  // without re-spending budget. Lives in the shared cache dir, next to the gql cache.
  const out = path.join(CACHE_DIR, "billing-probe.json");
  const record = { at: new Date().toISOString(), character: `${name}-${server} (${region})`, ...res };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(record, null, 2));
    console.log(`[probe] verdict saved to ${out} -- a future session reads this to decide on _BATCH_MAX / fan-out.`);
  } catch (e) { console.error(`[probe] could not save verdict: ${e.message || e}`); }
}

await main();
