// Pure, class-agnostic rotation helpers: empowered-hit detection and opener
// extraction. No ability names, no class assumptions, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { empoweredCount, openerSequence, fieldCastRates, usageDivergence, classifyUnderUse, cooldownGaps, castUsageGaps, castable, perCastGaps, sameHeroPeers, realOveruse, empoweredShare, empoweredStats, empowermentCandidate, dotUptimeGaps, petShareGap, buffWindowUplift, buffCdGap, selfBuffMatch, rotationLevers, medianCastRates, consensusOpener, openerDivergence, majorCooldownIds, cooldownStackFraction, cooldownStackGap } = await import("../docs/rotation.js");
const { setRunMetric } = await import("../docs/core.js");

// Run a body with the run metric forced, always restoring "dps" so it never leaks.
const asHealer = (fn) => { try { setRunMetric("hps"); return fn(); } finally { setRunMetric("dps"); } };

test("selfBuffMatch: the CAUSAL gate -- a buff that auras YOU passes, a taunt does not", () => {
  // The player's self-buffs this kill (core.buffUptimes shape: name -> { pct, guid }).
  // Recklessness applies its own aura (cast id == aura id 1719); Avatar 107574 too.
  const selfBuffs = {
    Recklessness: { pct: 18, guid: 1719 },
    Avatar: { pct: 22, guid: 107574 },
    "Battle Shout": { pct: 100, guid: 6673 },
  };
  // A real damage buff: matches by aura id (== cast id) -> passes.
  assert.equal(selfBuffMatch(1719, "Recklessness", selfBuffs), true);
  assert.equal(selfBuffMatch(107574, "Avatar", selfBuffs), true);
  // Name fallback: a CD whose cast id differs from its aura id still matches by name.
  assert.equal(selfBuffMatch(999999, "Avatar", selfBuffs), true);
  // PROVOKE (a taunt): no self-buff aura on the player -> REJECTED. This is the whole
  // fix -- the reverted lever recommended Provoke off a correlational uplift; with the
  // causal gate it can never qualify because casting it grants you no aura.
  assert.equal(selfBuffMatch(1161, "Provoke", selfBuffs), false);
  // Fortifying Brew / any other defensive the player did NOT self-buff with -> rejected.
  assert.equal(selfBuffMatch(115203, "Fortifying Brew", selfBuffs), false);
  // No buff data at all -> reject (fail closed, never a false positive).
  assert.equal(selfBuffMatch(1719, "Recklessness", {}), false);
  assert.equal(selfBuffMatch(1719, "Recklessness", null), false);
});

test("buffWindowUplift: measures damage rise in the window after a buff cast", () => {
  const window = 8;
  const evs = [];
  for (let t = 0; t < 200000; t += 1000) evs.push({ t, amount: 100 });
  for (const c of [0, 100000]) for (let dt = 0; dt < 8000; dt += 1000) evs.push({ t: c + dt, amount: 400 });
  const upl = buffWindowUplift([0, 100000], evs, { window });
  assert.ok(upl, "should measure when there are >=2 casts and events");
  assert.equal(upl.casts, 2);
  assert.ok(upl.uplift > 0.5, `real damage buff -> clear positive uplift (got ${upl.uplift})`);
  assert.ok(upl.inRate > upl.baseRate);
});

test("buffWindowUplift: ~zero uplift for a DEFENSIVE (no damage rise after the cast)", () => {
  const evs = [];
  for (let t = 0; t < 200000; t += 1000) evs.push({ t, amount: 100 });
  const upl = buffWindowUplift([50000, 150000], evs, { window: 8 });
  assert.ok(upl, "still measurable");
  assert.ok(Math.abs(upl.uplift) < 0.05, `a defensive produces no uplift (got ${upl.uplift})`);
});

test("buffWindowUplift: null when too few casts, no events, or the buff covers the whole fight", () => {
  assert.equal(buffWindowUplift([0], [{ t: 0, amount: 1 }]), null);
  assert.equal(buffWindowUplift([0, 1000], []), null);
  const evs = [{ t: 0, amount: 100 }, { t: 1000, amount: 100 }];
  assert.equal(buffWindowUplift([0, 500], evs, { window: 8 }), null);
});

test("buffCdGap: sizes a missed buff (post-gate); silent on no-uplift/non-deficit", () => {
  const gap = { youPerFight: 1, fieldPerFight: 3 };
  const upl = { uplift: 1.0, inRate: 800, baseRate: 400, casts: 1, windowSec: 8 };
  const g = buffCdGap(gap, upl, 64000);
  assert.ok(g, "fires on a real buff with a real deficit");
  assert.equal(g.missed, 2);
  assert.equal(g.pct, 10);
  // A self-buff that lifts ~nothing -> below minUplift floor, silent.
  assert.equal(buffCdGap(gap, { uplift: 0.01, inRate: 404, baseRate: 400, casts: 1, windowSec: 8 }, 64000), null);
  // No real deficit (you use it as much as the field) -> silent.
  assert.equal(buffCdGap({ youPerFight: 3, fieldPerFight: 3 }, upl, 64000), null);
  assert.equal(buffCdGap({ youPerFight: 2, fieldPerFight: 3 }, upl, 100000000), null);
  assert.equal(buffCdGap(null, upl, 64000), null);
  assert.equal(buffCdGap(gap, null, 64000), null);
  assert.equal(buffCdGap(gap, upl, 0), null);
});

test("BUFF-COOLDOWN end-to-end gate: a candidate with strong uplift but NO self-buff is REJECTED", () => {
  // This encodes the Provoke lesson at the gate level. A taunt pressed at pull/burst
  // shows a STRONG windowed uplift (correlation) AND a real cast deficit -- buffCdGap
  // alone would size it. The self-buff gate must reject it because casting it granted
  // the player no aura. Order: selfBuffMatch THEN buffWindowUplift/buffCdGap.
  const provokeId = 1161;
  const selfBuffs = { Recklessness: { pct: 18, guid: 1719 } };  // Provoke is NOT here
  // Build a timeline where damage spikes right after each "Provoke" cast (burst windows).
  const evs = [];
  for (let t = 0; t < 200000; t += 1000) evs.push({ t, amount: 100 });
  for (const c of [0, 100000]) for (let dt = 0; dt < 8000; dt += 1000) evs.push({ t: c + dt, amount: 500 });
  evs.sort((a, b) => a.t - b.t);
  const gap = { id: provokeId, youPerFight: 1, fieldPerFight: 4 };

  // The CAUSAL gate fires first and rejects -> we never even size it.
  const passes = selfBuffMatch(provokeId, "Provoke", selfBuffs);
  assert.equal(passes, false, "Provoke grants no self-buff -> rejected before sizing");

  // Sanity: had we (wrongly) skipped the gate, the correlational sizer WOULD have fired,
  // proving the gate -- not the uplift -- is what prevents the false positive.
  const upl = buffWindowUplift([0, 100000], evs, { window: 8 });
  const sizedIfUngated = buffCdGap(gap, upl, 200000);
  assert.ok(sizedIfUngated && sizedIfUngated.pct >= 1,
    "without the gate the correlational uplift sizes it -> exactly the Provoke FP the gate stops");
});

test("petShareGap: flags a pet spec under the field's pet share; silent for non-pet/matched", () => {
  // Unholy DK: your pets 27% of damage, field 38%. gain = (1-.27)/(1-.38) ~= 1.177.
  const g = petShareGap(0.27, 0.38);
  assert.equal(g.you, 27); assert.equal(g.field, 38);
  assert.equal(g.pct, Math.round(100 * (0.73 / 0.62 - 1)));   // ~18%
  // A non-pet spec (field pets ~2% = trinket-proc noise) never fires.
  assert.equal(petShareGap(0.0, 0.02), null);
  assert.equal(petShareGap(0.01, 0.03), null);
  // You match/beat the field -> silent (no false positive).
  assert.equal(petShareGap(0.40, 0.38), null);
  assert.equal(petShareGap(0.35, 0.38), null);   // within the 5pp band
});

test("dotUptimeGaps: flags a clipped DoT, silent on a well-maintained one", () => {
  const dots = [
    { name: "Devouring Plague", guid: 335467, share: 0.15 },
    { name: "Vampiric Touch", guid: 34914, share: 0.20 },
  ];
  // You clip DP (80% vs field 92%); VT is fine (95% vs 95%).
  const youUp = { 335467: 80, 34914: 95 }, fieldUp = { 335467: 92, 34914: 95 };
  const gaps = dotUptimeGaps(dots, youUp, fieldUp);
  assert.equal(gaps.length, 1, "only the clipped DoT fires");
  assert.equal(gaps[0].name, "Devouring Plague");
  assert.equal(gaps[0].pct, Math.round(100 * 0.15 * 12 / 80));   // share*(field-you)/you
  // A DoT within the noise band (<6pp) stays silent -> no false positive (Boxo case).
  assert.equal(dotUptimeGaps(dots, { 335467: 90, 34914: 95 }, fieldUp).length, 0);
  // Missing field data (too few peers) -> silent, not a guess.
  assert.equal(dotUptimeGaps(dots, youUp, {}).length, 0);
  // A CHANNEL/filler (Mind Flay) also ticks, but the field keeps it up only ~25% --
  // not a maintained DoT, so being below the field there must NOT fire a clip lever.
  const chan = [{ name: "Mind Flay", guid: 15407, share: 0.10 }];
  assert.equal(dotUptimeGaps(chan, { 15407: 14 }, { 15407: 25 }).length, 0, "channel (low field uptime) never fires");
});

test("realOveruse: an over-press vs a ~0 field is a build difference, not a rotation error", () => {
  // Cross-tree field (heroMatched null): you press Thrash 5.8/min, peers 0.0 --
  // they DROPPED the button (different hero tree), so "press it less" is wrong.
  const over = [
    { name: "Thrash", you: 5.8, field: 0 },
    { name: "Maul", you: 4.0, field: 1.5 },  // field DOES press it, just less -> real
  ];
  const real = realOveruse(over, null);
  assert.deepEqual(real.map((a) => a.name), ["Maul"]);
});

test("realOveruse: same-tree field keeps a zero-field over-press (a real wrong button)", () => {
  // heroMatched set: peers run YOUR tree and still press Thrash ~0 -> you really
  // are pressing a button your own build's best players don't.
  const over = [{ name: "Thrash", you: 5.8, field: 0 }];
  assert.equal(realOveruse(over, "Elune's Chosen").length, 1);
});

test("sameHeroPeers: compares you only to same-hero-tree peers when enough exist", () => {
  // 3 Elune's Chosen + 2 Druid of the Claw. You're Elune's Chosen -> keep the 3
  // who run your tree (else the DotC peers' 0 Thrash makes you look over-pressing).
  const peers = [
    { name: "a", hero: "Elune's Chosen" }, { name: "b", hero: "Elune's Chosen" },
    { name: "c", hero: "Elune's Chosen" }, { name: "d", hero: "Druid of the Claw" },
    { name: "e", hero: "Druid of the Claw" },
  ];
  const same = sameHeroPeers(peers, "Elune's Chosen");
  assert.equal(same.length, 3);
  assert.ok(same.every((p) => p.hero === "Elune's Chosen"));
});

test("sameHeroPeers: falls back to the whole field when too few share your tree", () => {
  // Only 1 peer on your tree -- not a real sample, so use all 5 (noisy beats none).
  const peers = [
    { name: "a", hero: "Elune's Chosen" }, { name: "b", hero: "Druid of the Claw" },
    { name: "c", hero: "Druid of the Claw" }, { name: "d", hero: "Druid of the Claw" },
    { name: "e", hero: "Druid of the Claw" },
  ];
  assert.equal(sameHeroPeers(peers, "Elune's Chosen").length, 5);
});

test("sameHeroPeers: unknown hero tree -> compare to the whole field", () => {
  const peers = [{ name: "a", hero: null }, { name: "b", hero: "X" }];
  assert.equal(sameHeroPeers(peers, null).length, 2);
});

test("empoweredShare: fraction of non-crit casts landing above 1.5x your own median", () => {
  // 10 hits: seven ~40k (bare, the median) and three ~100k (empowered). 100k > 1.5x
  // the 41k median, so empowered share = 3/10.
  const amts = [38000, 39000, 40000, 41000, 42000, 40000, 39000, 100000, 105000, 98000];
  assert.equal(empoweredShare(amts), 0.3);
});

test("empoweredShare: 0 when the ability is uniform (no hit clears 1.5x the median)", () => {
  // All hits cluster tightly around the median -- no empowered version to land.
  assert.equal(empoweredShare([40000, 41000, 42000, 39000, 40000, 43000, 41000, 40000]), 0);
});

test("empoweredShare: null when too few hits to judge", () => {
  assert.equal(empoweredShare([40000, 100000, 41000]), null);
});

test("empoweredStats: the share plus the concrete empowered/total counts (for '41/78' wording)", () => {
  const amts = [38000, 39000, 40000, 41000, 42000, 40000, 39000, 100000, 105000, 98000];
  assert.deepEqual(empoweredStats(amts), { share: 0.3, empowered: 3, total: 10 });
  assert.equal(empoweredStats([1, 2, 3]), null);          // too few -> null
});

test("empowermentCandidate: picks the high-VOLUME bimodal filler, NOT the hardest-median hit", () => {
  // Frost-Mage shape: Glacial Spike hits hard EVERY cast (high median, NOT bimodal -> no
  // empowered cluster); Ice Lance is small most casts, ~3x into Shatter (low median, bimodal,
  // and high total volume from many casts). The empowerment lever must analyze ICE LANCE.
  const hits = [
    { name: "Glacial Spike", med: 200000, empShare: 0, procBig: 0 },   // uniform big hit
    { name: "Ice Lance", med: 20000, empShare: 0.4, procBig: 5 },      // bimodal filler
    { name: "Frostbolt", med: 30000, empShare: null, procBig: 1 },
  ];
  const dmgTotals = { "Glacial Spike": 1_500_000, "Ice Lance": 3_000_000, Frostbolt: 2_000_000 };
  const biggest = hits[0];                                              // hardest-median
  assert.equal(empowermentCandidate(hits, dmgTotals, biggest).name, "Ice Lance");
  // Among TWO bimodal abilities, volume breaks the tie.
  const two = [{ name: "A", empShare: 0.3, procBig: 3 }, { name: "B", empShare: 0.3, procBig: 3 }];
  assert.equal(empowermentCandidate(two, { A: 100, B: 900 }).name, "B");
  // No bimodal ability -> fall back to biggest (don't regress specs whose big hit IS the one).
  const uniform = [{ name: "X", empShare: 0, procBig: 0 }];
  assert.equal(empowermentCandidate(uniform, {}, biggest).name, "Glacial Spike");
  assert.equal(empowermentCandidate([], {}, null), null);
});

test("empowerment lever: fires on the candidate when your empowered SHARE trails the field, with counts", () => {
  // perCast tagged for the candidate (Ice Lance): you 40% vs field 70% empowered, 30pp gap,
  // sized pct >= 1 -> a measured EMPOWERMENT lever naming the concrete wasted casts.
  const rot = {
    perCast: [{ name: "Ice Lance", pct: 6, youEmp: 0.40, fieldEmp: 0.70, youEmpCount: 32, youEmpN: 80 }],
    usage: { under: [], over: [] }, abilityIds: { "Ice Lance": 30455 },
  };
  const emp = rotationLevers(rot).find((fnd) => /EMPOWERMENT/.test(fnd.text));
  assert.ok(emp, "lever fires when share trails by >= 12pp");
  assert.match(emp.text, /Ice Lance/);
  assert.match(emp.text, /32\/80/);                       // your concrete count
  assert.match(emp.text, /~56\/80/);                      // field share (0.70) x your N (80)
  // Equal shares -> NOT timing -> silent (the gap is per-cast stats, not empowerment).
  const even = { perCast: [{ name: "Ice Lance", pct: 6, youEmp: 0.68, fieldEmp: 0.70, youEmpCount: 54, youEmpN: 80 }], usage: { under: [], over: [] }, abilityIds: {} };
  assert.equal(rotationLevers(even).filter((fnd) => /EMPOWERMENT/.test(fnd.text)).length, 0);
});

test("empoweredShare is the gear-robust gate -- two players with the SAME share despite different hit sizes", () => {
  // A low-gear player (small hits) and a buffed player (big hits) who BOTH land the
  // empowered version 1/4 of the time read as equal -- the comparison isn't fooled
  // by a flat damage amp (comp / a boss damage-taken debuff lifts both clusters).
  const lo = [20000, 21000, 22000, 20000, 21000, 22000, 50000, 51000];   // 2/8 empowered
  const hi = [40000, 42000, 44000, 40000, 42000, 44000, 100000, 102000]; // 2/8 empowered
  assert.equal(empoweredShare(lo), empoweredShare(hi));
});

test("perCastGaps: flags a hard hit you land WEAK -- ability-specific, beyond the comp/stats edge", () => {
  // The field does 1.4x your total overall (comp+stats). Your Big hits 100k/cast,
  // the field's lands 220k (2.2x) -- WAY beyond the 1.4x baseline, so it's
  // ability-specific (un-empowered), not crit/comp. Your Filler matches the field
  // once its 1.4x edge is removed, so it must NOT fire. Big: 70 casts of 7,000k
  // total = 100k/cast; excess over baseline = 220k/1.4 - 100k = ~57k; *70 casts /
  // 10,000k total * 0.5 damp ~= 20%.
  const yourAb = { Big: { total: 7000000, casts: 70 }, Filler: { total: 3000000, casts: 100 } };
  const fieldAb = { Big: 220000, Filler: 42000 };   // Filler 42k = 30k*1.4 (just the overall edge)
  const gaps = perCastGaps(yourAb, fieldAb, 1.4, 10000000);
  assert.equal(gaps.length, 1, "only the ability behind by MORE than the overall edge fires");
  assert.equal(gaps[0].name, "Big");
  assert.equal(gaps[0].pct, 20);
  assert.ok(gaps[0].raw > 2 && gaps[0].raw < 2.3);
});

test("perCastGaps: silent when an ability only rides the field's general edge (stats/comp, not empowerment)", () => {
  // Field is 1.5x you overall; this ability is exactly 1.5x per cast -> not
  // ability-specific, so it's the comp/stats levers' job, not an empowerment fix.
  assert.equal(perCastGaps({ A: { total: 1000000, casts: 50 } }, { A: 30000 }, 1.5, 1000000).length, 0);
});

test("perCastGaps: needs enough casts (a 1-cast sample is too noisy to name)", () => {
  assert.equal(perCastGaps({ A: { total: 400000, casts: 2 } }, { A: 600000 }, 1.2, 1000000).length, 0);
});

test("castUsageGaps: flags a buff/pet cooldown the field presses more (by ability id)", () => {
  // 300s fight. Field casts a cooldown id 0.5/min (2.5/kill), you 0.2/min (1/kill).
  // Below usageDivergence's floor AND not in the damage table -- only this catches it.
  const gaps = castUsageGaps(
    { 132578: 0.2, 100780: 50 },   // you: Niuzao 1x, Tiger Palm filler
    { 132578: 0.5, 100780: 51 },   // field: Niuzao 2.5x, filler
    300,
  );
  assert.equal(gaps.length, 1, "the 51/min filler is outside the cooldown band");
  assert.equal(gaps[0].id, "132578");
  assert.equal(Math.round(gaps[0].fieldPerFight), 3);   // 0.5/min * 5min ~= 2.5 -> 3
  assert.equal(Math.round(gaps[0].youPerFight), 1);
});

test("castUsageGaps: silent when you use the cooldown about as often as the field", () => {
  assert.equal(castUsageGaps({ 132578: 0.45 }, { 132578: 0.5 }, 300).length, 0);
});

test("cooldownGaps: catches a low-frequency cooldown usageDivergence's floor misses", () => {
  // Field casts a big cooldown 0.5/min, you 0.2/min -- below usageDivergence's
  // 0.5 floor, so it's invisible there. Here it's caught and SIZED from damage.
  // 300s fight: you 1 cast, field 2.5 casts; your dmg/cast = 600k/1 = 600k.
  // missed = (2.5-1)*600k = 900k of a 6,000k total = 15%.
  const cds = cooldownGaps(
    { BigCD: 0.2, Filler: 30 },
    { BigCD: 0.5, Filler: 31 },
    { BigCD: 600000, Filler: 5400000 },
    300,
  );
  assert.equal(cds.length, 1, "filler (31/min) is outside the cooldown band; only the CD is flagged");
  assert.equal(cds[0].name, "BigCD");
  assert.equal(cds[0].pct, 15);
  // usageDivergence (floor 0.5) does NOT see this cooldown at all.
  assert.equal(usageDivergence({ BigCD: 0.2 }, { BigCD: 0.5 }).under.length, 0);
});

test("cooldownGaps: silent when you use the cooldown about as much as the field", () => {
  assert.equal(cooldownGaps({ CD: 0.45 }, { CD: 0.5 }, { CD: 500000 }, 300).length, 0);
});

test("classifyUnderUse: baseline button you skip is NOT a missing talent", () => {
  // Shield of the Righteous is baseline -- in neither your talents nor the spec's
  // talent universe. Skipping it must fall through to an ordinary rotation fix,
  // never "respec" (the Prot Paladin over-reach this guards against).
  const top = { name: "Shield of the Righteous", you: 0, field: 20 };
  const talent = { taken: new Set(["Crusader's Reprieve"]), universe: new Set(["Crusader's Reprieve", "Sentinel"]) };
  assert.equal(classifyUnderUse(top, talent), null);
});

test("classifyUnderUse: a talent you skipped (peers run it) -> respec", () => {
  const top = { name: "Rupture", you: 0, field: 2.1 };
  const talent = { taken: new Set(["Garrote"]), universe: new Set(["Garrote", "Rupture"]) };
  assert.equal(classifyUnderUse(top, talent), "missing-talent");
});

test("classifyUnderUse: a talent you took but never press -> build/usage problem", () => {
  const top = { name: "Rupture", you: 0, field: 2.1 };
  const talent = { taken: new Set(["Rupture"]), universe: new Set(["Garrote", "Rupture"]) };
  assert.equal(classifyUnderUse(top, talent), "talented-unused");
});

test("classifyUnderUse: only fires when you NEVER press it (not a mild gap)", () => {
  const talent = { taken: new Set(), universe: new Set(["Rupture"]) };
  assert.equal(classifyUnderUse({ name: "Rupture", you: 1.0, field: 2.1 }, talent), null); // you do press it
  assert.equal(classifyUnderUse({ name: "Rupture", you: 0, field: 1.0 }, talent), null);   // field rarely casts it
});

test("classifyUnderUse: no talent data -> never claim a talent fix", () => {
  const top = { name: "Rupture", you: 0, field: 2.1 };
  assert.equal(classifyUnderUse(top, null), null);
});

test("usageLevers: a healer never gets a DAMAGE-cast respec/press-more lever (the whole analysis is a misframe)", () => {
  // A healer's damage casts diverge from the HPS-ranked field's; u.under[0] is a damage
  // ability classified as a skipped talent -> the TALENTS/BUILD branch would have said
  // "respec to the field's build (the one with Rupture)". That's a damage respec aimed at
  // a healer -- exactly what the press-more suppression exists to prevent. Must be silent.
  const rot = {
    usage: { under: [{ name: "Rupture", you: 0, field: 2.1 }], over: [] },
    talent: { taken: new Set(["Garrote"]), universe: new Set(["Garrote", "Rupture"]) },
    heroMatched: true,
    abilityIds: {},
  };
  // DPS run: the lever fires (sanity that the fixture reaches the TALENTS/BUILD branch).
  const dps = rotationLevers(rot);
  assert.ok(dps.some((l) => /TALENTS\/BUILD/.test(l.text)), "DPS run -> the damage respec lever DOES fire");
  // Healer run: suppressed entirely -- no rotation lever from the damage-cast analysis.
  asHealer(() => {
    const heal = rotationLevers(rot);
    assert.equal(heal.length, 0, "healer run -> no damage-cast rotation lever at all");
  });
});

test("castable: a skipped talent (peers' hero tree) is NOT castable -> don't say press it more", () => {
  // Guardian on Elune's Chosen vs Druid-of-the-Claw peers who press Ravage: Ravage
  // is in the talent universe but the player never took it -> can't cast it.
  const talent = { taken: new Set(["Mangle", "Lunar Beam"]), universe: new Set(["Ravage", "Lunar Beam"]) };
  assert.equal(castable("Ravage", talent), false);     // skipped talent -> different build
  assert.equal(castable("Lunar Beam", talent), true);  // talented -> you have it
  assert.equal(castable("Mangle", talent), true);      // baseline (not in universe) -> you have it
});

test("castable: missing talent data -> keep it (can't prove a build mismatch)", () => {
  assert.equal(castable("Ravage", null), true);
  assert.equal(castable("Ravage", { taken: new Set() }), true);  // no universe -> unknown
});

test("fieldCastRates takes the per-ability median across peers (absent = 0)", () => {
  const peers = [
    { Mangle: 6, Ravage: 5 },
    { Mangle: 6, Ravage: 4 },
    { Mangle: 6 },                 // this peer never pressed Ravage -> counts as 0
  ];
  const r = fieldCastRates(peers);
  assert.equal(r.Mangle, 6);
  assert.equal(r.Ravage, 4);       // median of [5, 4, 0]
});

test("usageDivergence flags the wrong-button swap (Raze pressed, Ravage missing)", () => {
  // You spam Raze and never press Ravage; the field does the opposite.
  const you = { Mangle: 6, Raze: 5, Ravage: 0 };
  const field = { Mangle: 6, Raze: 0, Ravage: 5 };
  const { under, over } = usageDivergence(you, field);
  assert.equal(under[0].name, "Ravage");   // field presses it, you don't -> press more
  assert.equal(over[0].name, "Raze");      // you press it, field doesn't -> wrong button
  // Mangle matches -> not flagged either way
  assert.ok(!under.some((a) => a.name === "Mangle"));
  assert.ok(!over.some((a) => a.name === "Mangle"));
});

test("usageDivergence ignores small/rare differences (floor + ratio)", () => {
  const you = { A: 5.0, B: 0.3 };
  const field = { A: 5.4, B: 0.6 };  // A within ratio; B below floor
  const { under, over } = usageDivergence(you, field);
  assert.equal(under.length, 0);
  assert.equal(over.length, 0);
});

test("usageDivergence catches a SLOW ROTATION: core button cast far less but below 2x", () => {
  // Demonology pressing every core button ~1.6x below the field trips no single 2x gap,
  // so the whole deficit used to vanish into the PLAYSTYLE remainder. The big-absolute-gap
  // band now names it (so usageDamageGaps can size it from measured damage).
  const you = { "Hand of Gul'dan": 22, "Shadow Bolt": 14, Demonbolt: 19 };
  const field = { "Hand of Gul'dan": 34, "Shadow Bolt": 23, Demonbolt: 22 };
  const { under } = usageDivergence(you, field);
  assert.ok(under.some((a) => a.name === "Hand of Gul'dan"));  // gap 12, ratio 1.55 -> flagged
  assert.ok(under.some((a) => a.name === "Shadow Bolt"));      // gap 9,  ratio 1.64 -> flagged
  assert.ok(!under.some((a) => a.name === "Demonbolt"));       // gap 3 but ratio 1.16 (<1.4) -> not
});

test("usageDivergence does NOT flag a high-volume filler cast only slightly less (no big ratio)", () => {
  // A big ABSOLUTE deficit alone isn't enough -- a cheap filler the field weaves a bit more
  // (30 vs 25, ratio 1.2) must stay silent, or every fast caster would 'under-press' it.
  const { under } = usageDivergence({ Filler: 25 }, { Filler: 30 });  // gap 5 but ratio 1.2 (<1.4)
  assert.equal(under.length, 0);
});

test("medianCastRates: medians per ability across kills so one pull's noise can't drive the lever", () => {
  // One bad pull where you spammed the wrong button (Whirlwind 8, Raging Blow 2) shouldn't
  // define the lever when your other kills are clean (Raging Blow ~7). Median per ability.
  const kills = [
    { "Raging Blow": 7, "Whirlwind": 3 },
    { "Raging Blow": 2, "Whirlwind": 8 },   // the noisy pull
    { "Raging Blow": 7, "Whirlwind": 3 },
  ];
  const m = medianCastRates(kills);
  assert.equal(m["Raging Blow"], 7);   // the typical rate, not the bad-pull 2
  assert.equal(m["Whirlwind"], 3);
  // An ability cast on only some kills counts as 0 on the kills you skipped it (union).
  const sparse = medianCastRates([{ X: 6 }, { X: 6, Y: 4 }, { X: 6 }]);
  assert.equal(sparse["X"], 6);
  assert.equal(sparse["Y"], 0, "Y cast on 1 of 3 kills -> median 0 (you usually skip it)");
  // One kill (or none) -> unchanged passthrough, no aggregation artifacts.
  assert.deepEqual(medianCastRates([{ A: 5 }]), { A: 5 });
  assert.deepEqual(medianCastRates([]), {});
  assert.deepEqual(medianCastRates([null, { A: 5 }]), { A: 5 }, "drops failed-kill nulls");
});

test("empoweredCount finds the high cluster of outsized hits", () => {
  // Mostly ~60k baseline hits, plus a few empowered ~140k ones.
  const amts = [60000, 62000, 58000, 61000, 59000, 140000, 145000, 138000];
  assert.equal(empoweredCount(amts), 3);          // the three ~140k hits
  assert.equal(empoweredCount([1, 2, 3]), 0);     // too few samples -> 0
  assert.equal(empoweredCount([]), 0);
});

test("empoweredCount is class-agnostic (works on any ability's amounts)", () => {
  // A caster nuke that crits hard occasionally.
  const amts = [10000, 11000, 9000, 10500, 9500, 22000, 21000];
  assert.equal(empoweredCount(amts, 1.8), 2);
});

test("openerSequence takes the first N casts within the window", () => {
  const casts = [
    { t: 0, name: "A" }, { t: 1000, name: "B" }, { t: 2000, name: "C" },
    { t: 25000, name: "D" },
  ];
  assert.deepEqual(openerSequence(casts, 20000, 8), ["A", "B", "C"]); // 25s excluded
  assert.deepEqual(openerSequence(casts, 20000, 2), ["A", "B"]);      // capped at n
  assert.deepEqual(openerSequence([], 20000, 8), []);
});

// The pet-damage lever fires for EVERY pet spec (BM Hunter, Unholy DK, Demo Warlock), so its
// advice must be class-agnostic -- naming DK cooldowns (Army/Gargoyle) to a Hunter is the
// hard-coded-ability bug CLAUDE.md forbids. Found reviewing Kynigós (BM Hunter).
test("petLever: pet advice is class-agnostic -- no hard-coded ability names", () => {
  const rot = {
    petGap: { you: 34, field: 39, pct: 8 },
    usage: { under: [], over: [] }, talent: { taken: new Set(), universe: new Set() },
    heroMatched: true, abilityIds: {},
  };
  const out = rotationLevers(rot);
  const pet = out.find((l) => /PET (DAMAGE|HEALING)/.test(l.text));
  assert.ok(pet, "pet lever fires when pets under-perform the field");
  assert.doesNotMatch(pet.text, /Army|Gargoyle|Dark Transformation|Bestial Wrath|Niuzao|Dreadstalker/,
    "no class-specific ability names in the generic pet advice");
});

// OFF-BUILD rotation caveat: when your hero tree is known but the rotation peer pool isn't it
// (too few same-tree peers -> sameHeroPeers fell back to the off-tree field), a "press X more"
// gap is build-confounded. Mirror realOveruse's build-awareness: keep the lever (impact stays)
// but flag it may be the build, not a misplay. Found reviewing Boxo (Voidweaver vs 100% Archon).
test("rotation: off-build (hero tree != field) caveats the press-more lever; on-build doesn't", () => {
  const base = {
    usage: { under: [{ name: "Vampiric Touch", you: 0.6, field: 2.1, dmgPct: 9 }], over: [] },
    talent: { taken: new Set(["Vampiric Touch"]), universe: new Set(["Vampiric Touch"]) },
    abilityIds: {},
  };
  const off = rotationLevers({ ...base, yourHero: "Voidweaver", heroMatched: null });
  const offLever = off.find((l) => /press .*Vampiric Touch.* more/.test(l.text));
  assert.ok(offLever, "press-more lever fires");
  assert.match(offLever.text, /different hero tree/, "off-build -> build caveat appended");
  const on = rotationLevers({ ...base, yourHero: "Voidweaver", heroMatched: "Voidweaver" });
  const onLever = on.find((l) => /press .*Vampiric Touch.* more/.test(l.text));
  assert.ok(onLever, "press-more lever fires when hero-matched");
  assert.doesNotMatch(onLever.text, /different hero tree/, "on-build -> no caveat");
});

// --- OPENER consensus + divergence diagnostic ----------------------------------

test("consensusOpener: position-wise modal opener, truncated where the field diverges", () => {
  // 4 peers agree on Niuzao > Breath > Keg for the first 3, then scatter.
  const openers = [
    ["Niuzao", "Breath of Fire", "Keg Smash", "Tiger Palm"],
    ["Niuzao", "Breath of Fire", "Keg Smash", "Blackout Kick"],
    ["Niuzao", "Breath of Fire", "Keg Smash", "Rising Sun Kick"],
    ["Niuzao", "Breath of Fire", "Spinning Crane", "Tiger Palm"],
  ];
  const c = consensusOpener(openers);
  // Pos0/1 unanimous; pos2 Keg has 3/4 (>=0.34) so kept; pos3 is a 2/4 tie on Tiger Palm.
  assert.deepEqual(c.slice(0, 3), ["Niuzao", "Breath of Fire", "Keg Smash"]);
  assert.equal(consensusOpener([]), null);
  assert.equal(consensusOpener(null), null);
});

test("openerDivergence: flags a high-consensus early cooldown you DELAY past minPosGap", () => {
  // Field opens with Niuzao at pos 0; you cast 2 fillers first (Niuzao at pos 2).
  const peers = Array.from({ length: 5 }, () => ["Niuzao", "Breath of Fire", "Keg Smash"]);
  const you = ["Blackout Kick", "Tiger Palm", "Niuzao", "Breath of Fire"];
  const og = openerDivergence(you, peers);
  assert.equal(og.ability, "Niuzao");
  assert.equal(og.omitted, false);
  assert.equal(og.youPos, 2);
  assert.equal(og.delay, 2);
});

test("openerDivergence: the field's lead cast SKIPPED from your opener reads as omitted", () => {
  // Field leads with Niuzao(0); you never cast it in your opener (you open on fillers).
  const peers = Array.from({ length: 5 }, () => ["Niuzao", "Keg Smash", "Breath of Fire"]);
  const you = ["Tiger Palm", "Blackout Kick", "Keg Smash"];
  const og = openerDivergence(you, peers);
  assert.equal(og.ability, "Niuzao", "the field's pos-0 lead, absent from your opener");
  assert.equal(og.omitted, true);
  assert.equal(og.youPos, null);
});

test("openerDivergence: silent when you open about as early, on a split field, or no data", () => {
  const peers = Array.from({ length: 5 }, () => ["Niuzao", "Breath of Fire", "Keg Smash"]);
  // You open with Niuzao at pos 0 too -> no divergence.
  assert.equal(openerDivergence(["Niuzao", "Keg Smash"], peers), null);
  // Split field: only 2/5 open with Niuzao (< minShare) -> no consensus to diverge from.
  const split = [["Niuzao"], ["Niuzao"], ["Tiger Palm"], ["Keg Smash"], ["Blackout Kick"]];
  assert.equal(openerDivergence(["Tiger Palm", "Niuzao"], split), null);
  // Too few peers.
  assert.equal(openerDivergence(["x"], [["Niuzao"], ["Niuzao"]]), null);
  assert.equal(openerDivergence([], peers), null);
});

test("openerLever (via rotationLevers): renders an INFO diagnostic from openerGap, none without", () => {
  const rot = { abilityIds: { Niuzao: 132578 },
    openerGap: { ability: "Niuzao", peerShare: 0.8, peerPos: 0, youPos: 2, omitted: false, delay: 2 } };
  const lev = rotationLevers(rot).filter((l) => /^OPENER:/.test(l.text));
  assert.equal(lev.length, 1);
  assert.equal(lev[0].impact, 0, "diagnostic: no DPS claim");
  assert.equal(lev[0].kind, "OPENER");
  assert.match(lev[0].text, /delay it ~2 globals/);
  // Omitted variant reads "isn't in your opener at all".
  const omit = rotationLevers({ abilityIds: {}, openerGap: { ability: "Niuzao", peerShare: 0.8, peerPos: 0, youPos: null, omitted: true, delay: Infinity } });
  assert.match(omit.find((l) => /^OPENER:/.test(l.text)).text, /isn't in your opener at all/);
  // No openerGap (the gates suppressed it) -> no opener line.
  assert.equal(rotationLevers({ abilityIds: {} }).filter((l) => /^OPENER:/.test(l.text)).length, 0);
});

// --- CD ALIGNMENT (cooldown stacking) diagnostic -------------------------------

test("majorCooldownIds: the low-frequency band, by ability id (fillers excluded)", () => {
  const rate = { 100: 30, 200: 0.5, 300: 1.0, 400: 0.05, 500: 2.0 };
  const ids = majorCooldownIds(rate);   // keep 0.15..1.5/min -> 200, 300
  assert.deepEqual(ids.sort(), ["200", "300"]);
  assert.deepEqual(majorCooldownIds({}), []);
});

test("cooldownStackFraction: stacked cooldowns score high, scattered score low", () => {
  // Two CDs (ids 1,2) cast in tight pairs -> every cast is within 10s of the other CD.
  const stacked = { 1: [0, 60000, 120000], 2: [2000, 62000, 122000] };
  assert.equal(cooldownStackFraction(stacked, ["1", "2"]), 1, "all 6 casts stacked");
  // Same casts pushed far apart -> none within 10s of a DIFFERENT cd.
  const scattered = { 1: [0, 60000, 120000], 2: [30000, 90000, 150000] };
  assert.equal(cooldownStackFraction(scattered, ["1", "2"]), 0, "none stacked");
  // A lone cooldown can't stack -> null; too few casts -> null.
  assert.equal(cooldownStackFraction({ 1: [0, 60000, 120000, 180000] }, ["1"]), null);
  assert.equal(cooldownStackFraction({ 1: [0], 2: [1000] }, ["1", "2"]), null);
});

test("cooldownStackGap: fires only when you trail the field's stack rate by the margin", () => {
  // You stack 20%, the field medians ~80% -> a real gap.
  const g = cooldownStackGap(0.2, [0.8, 0.7, 0.9, 0.8]);
  assert.ok(g); assert.equal(g.you, 0.2); assert.equal(g.field, 0.8);
  // You stack about as much as the field -> silent.
  assert.equal(cooldownStackGap(0.7, [0.8, 0.7, 0.75]), null);
  // The field ALSO spreads (low field fraction) -> spreading is correct here, silent.
  assert.equal(cooldownStackGap(0.1, [0.2, 0.15, 0.25]), null);
  // No field baseline / no your-fraction -> null (never guess).
  assert.equal(cooldownStackGap(0.1, [0.8]), null);
  assert.equal(cooldownStackGap(null, [0.8, 0.8, 0.8]), null);
});

test("cdAlignLever (via rotationLevers): INFO diagnostic from cdAlign, none without", () => {
  const lev = rotationLevers({ abilityIds: {}, cdAlign: { you: 0.2, field: 0.8 } })
    .filter((l) => /^CD ALIGNMENT:/.test(l.text));
  assert.equal(lev.length, 1);
  assert.equal(lev[0].impact, 0, "diagnostic: no DPS claim");
  assert.equal(lev[0].kind, "CD_ALIGN");
  assert.match(lev[0].text, /20% of your major-cooldown casts.*vs the field's 80%/);
  assert.equal(rotationLevers({ abilityIds: {} }).filter((l) => /^CD ALIGNMENT:/.test(l.text)).length, 0);
});
