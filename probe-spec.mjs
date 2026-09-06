// Cheap spec probe: detect a character's class/spec from RANKING queries only
// (characterZone + characterEncounter), no peer/table fetches. ~20-30 WCL pts vs
// ~600-1800 for a full prescribe -- so we probe many candidates and full-scan only
// the genuinely-new specs. Usage: node probe-spec.mjs "Name" Server [US]
process.env.WCL_ALLOW_FETCH = process.env.WCL_ALLOW_FETCH || "1";
const { characterZone, characterEncounter } = await import("./docs/core.js");
const [, , name, server, region = "US"] = process.argv;
const DIFFS = [5, 4, 3, 2];
let out = { name, server, error: "not found" };
for (const d of DIFFS) {
  let cz;
  try { cz = await characterZone(name, server, region, d); } catch (e) { continue; }
  const killed = ((cz && cz.zoneRankings && cz.zoneRankings.rankings) || []).filter((r) => (r.totalKills || 0) > 0);
  if (!killed.length) continue;
  // Most-recent kill across encounters -> its spec/class (ranking queries are cheap).
  let best = null;
  for (const r of killed) {
    let er;
    try { er = await characterEncounter(name, server, region, r.encounter.id, d); } catch (e) { continue; }
    for (const k of ((er && er.ranks) || [])) if (!best || (k.startTime || 0) > (best.startTime || 0)) best = k;
  }
  if (best) { out = { name, server, difficulty: d, class: best.class, spec: best.spec, bestSpec: best.bestSpec }; break; }
}
console.log(JSON.stringify(out));
