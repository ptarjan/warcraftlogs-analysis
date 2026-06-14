// The prescription's whole point is one list of changes ordered "biggest DPS
// first". A finding is { dim, impact, label, text }: impact (a number) drives the
// order, label is the matching display string, and DPS()/COMP()/INFO build the
// two together so they can never drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { DPS, COMP, INFO, finding, fieldDelta, setRunMetric } = await import("../docs/core.js");          // shared Finding currency
const { rotationLevers } = await import("../docs/rotation.js");

test("finding tags its basis: estimate by default, measured on opt-in", () => {
  assert.equal(finding("Gear", DPS(2), "x").basis, "est");          // levers must opt IN to "measured"
  assert.equal(finding("Execution", DPS(3), "y", "measured").basis, "measured");
});

test("fieldDelta measures an attribute's value from the field (have vs not)", () => {
  // 5 with it median 110, 5 without median 100 -> +10%.
  const dps = [110, 110, 110, 110, 110, 100, 100, 100, 100, 100];
  const has = [true, true, true, true, true, false, false, false, false, false];
  const d = fieldDelta(dps, has);
  assert.equal(Math.round(d.pct), 10);
  assert.deepEqual([d.nHave, d.nNot], [5, 5]);
  // No counterfactual (everyone has it) -> not measurable.
  assert.equal(fieldDelta([100, 100, 100, 100, 100], [true, true, true, true, true]), null);
  // Too few on one side -> null.
  assert.equal(fieldDelta([110, 100, 100, 100, 100], [true, false, false, false, false]), null);
});
const { rxHeadline, executionLevers, latencyLever, trinketLevers, reconcileImpacts, pickCurrentKill, pickBenchmarkKill, remainderKind, isEliteParse, verdictLever } = await import("../docs/prescribe.js");

test("pickBenchmarkKill: median-parse kill, not an outlier survival kill", () => {
  // A tank with a great Imperator parse but a terrible recent Belo'ren kill (a
  // survival pull). Most-recent would benchmark Belo'ren -> absurd '200% behind';
  // median-parse picks a representative kill instead.
  const kills = [
    { ilvl: 279, rankPercent: 94, boss: "Imperator", startTime: 100 },
    { ilvl: 279, rankPercent: 70, boss: "Vorasius", startTime: 200 },
    { ilvl: 279, rankPercent: 30, boss: "Beloren", startTime: 900 },
  ];
  assert.equal(pickBenchmarkKill(kills).boss, "Vorasius", "median parse, not the recent outlier");
  // Outside the ilvl band is excluded even if recent.
  const banded = pickBenchmarkKill([
    { ilvl: 279, rankPercent: 90, boss: "A", startTime: 1 },
    { ilvl: 270, rankPercent: 50, boss: "old-tier", startTime: 9 },
  ]);
  assert.equal(banded.boss, "A");
  assert.equal(pickBenchmarkKill([]), null);
});
const { embellishmentRx, gemLever, statScore, gearLevers, dedupeUniqueSwaps } = await import("../docs/gear.js");          // gear-domain lever

test("gearLevers: many same-stat swaps collapse into ONE legible re-itemize line", () => {
  const sw = (slot, gain) => ({ slot, gain, fromId: 1, fromName: `${slot}-old`, toId: 2, toName: `${slot}-new` });
  // 2 swaps -> listed individually (a short list is fine).
  const few = gearLevers({ swaps: [sw("Neck", 150), sw("Ring1", 120)], restats: [] }, "haste");
  assert.equal(few.filter((x) => /via (Neck|Ring1)/.test(x.text)).length, 2);
  // 5 swaps -> ONE grouped finding naming every slot, not five separate lines.
  const many = gearLevers({ swaps: ["Neck", "Ring1", "Ring2", "Feet", "Back"].map((s) => sw(s, 150)), restats: [] }, "haste");
  const reit = many.filter((x) => /re-itemize/.test(x.text));
  assert.equal(reit.length, 1, "5 swaps -> one grouped line");
  for (const s of ["Neck", "Ring1", "Ring2", "Feet", "Back"]) assert.match(reit[0].text, new RegExp(s));  // every exact swap kept
  assert.ok(!many.some((x) => /via Neck/.test(x.text)), "no separate per-slot swap lines");
});

test("gearLevers: a MEASURED-zero priority stat suppresses the re-itemize advice", () => {
  // When the field measures no benefit from stacking this stat at your ilvl (pct
  // rounds to 0), recommending a re-itemize for "~1%, measured: peers gain 0% more"
  // is self-contradicting. Drop the swaps/restats; gems/embellishments stay.
  const sw = (slot, gain) => ({ slot, gain, fromId: 1, fromName: `${slot}-old`, toId: 2, toName: `${slot}-new` });
  const swaps = ["Neck", "Belt", "Ring1"].map((s) => sw(s, 130));
  const zero = gearLevers({ swaps, restats: [] }, "haste", { perRating: 0.001, pct: 0.3, nHave: 5, nNot: 5 });
  assert.ok(!zero.some((x) => /re-itemize|via (Neck|Belt|Ring1)/.test(x.text)), "measured-0% -> no stat-swap advice");
  // A measurable benefit (pct rounds to >=1%) still produces the re-itemize line.
  const real = gearLevers({ swaps, restats: [] }, "haste", { perRating: 0.02, pct: 2, nHave: 5, nNot: 5 });
  assert.ok(real.some((x) => /re-itemize/.test(x.text)), "measured 2% -> re-itemize fires");
});

test("dedupeUniqueSwaps: a unique ring can't be recommended for both ring slots", () => {
  // Both rings independently pick the field-favored Omission of Light (+160). You
  // can only wear one -- keep the bigger-gain slot, drop the duplicate.
  const swaps = [
    { slot: "Ring1", toId: 251093, toName: "Omission of Light", gain: 160, unique: true },
    { slot: "Ring2", toId: 251093, toName: "Omission of Light", gain: 120, unique: true },
    { slot: "Feet", toId: 250026, toName: "Rootslippers", gain: 73, unique: true },
  ];
  const out = dedupeUniqueSwaps(swaps);
  assert.deepEqual(out.map((s) => s.slot), ["Ring1", "Feet"]);   // Ring2 (smaller gain) dropped
  // Non-unique items may legitimately fill two slots (e.g. a profession base item).
  const nonUnique = [
    { slot: "Ring1", toId: 9, toName: "Plain Band", gain: 50, unique: false },
    { slot: "Ring2", toId: 9, toName: "Plain Band", gain: 50, unique: false },
  ];
  assert.equal(dedupeUniqueSwaps(nonUnique).length, 2);
});

test("statScore: bigger stat gains rank above smaller ones (not a flat band)", () => {
  const big = statScore(260), small = statScore(86);
  assert.ok(big.impact > small.impact, "a +260 swap must outweigh a +86 swap");
  assert.match(big.label, /% (DPS|HPS)/);
  // Floor so a tiny gain still shows, cap so one piece can't dominate pre-reconcile.
  assert.equal(statScore(10).impact, 0.5);
  assert.equal(statScore(99999).impact, 5);
  assert.equal(statScore(0).impact, 0.5);
});

test("executionLevers: press-faster doesn't pipe the raw cast gap into DPS%", () => {
  // 44% fewer casts must NOT become a ~44% DPS lever -- it's damped (~half) and
  // capped at the headroom (60% gap -> 0.6x = 36) and a hard 12% ceiling. No
  // rotation under-use here, so the whole deficit is genuine speed.
  const execd = { pressExcess: 2.0, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 16, field: 28, pct: 44 } };
  const [press] = executionLevers(execd, rot, 60);
  assert.equal(press.impact, 12);                       // capped, not 44
  assert.match(press.text, /raw speed/);                // the measured cast counts are still cited
  assert.match(press.text, /not latency/);              // overshoot low -> "not latency"
});

test("executionLevers: a never-pressed core ability isn't double-counted as press-faster", () => {
  // The whole cast deficit (16 vs 28) is explained by a missing Shield of the
  // Righteous (20/min the field presses, you don't). That belongs to the ROTATION
  // lever, so press-faster falls back to the idle-time proxy (~3%), not ~12%.
  const execd = { pressExcess: 2.0, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 16, field: 28, pct: 44 },
    usage: { under: [{ name: "Shield of the Righteous", you: 0, field: 20, gap: 20 }], over: [] } };
  const [press] = executionLevers(execd, rot, 60);
  assert.equal(press.impact, 3);                        // idle proxy, not the cast gap
  assert.match(press.text, /mostly the rotation fix/);
});

test("executionLevers: movement lever needs a POSITIVE median loss, not worstRange alone", () => {
  // A player fine on most fights but bad on two has a negative/zero median loss.
  // Printing "you lose ~-0.5s/min" is misleading noise -- suppress it even though a
  // worst-boss callout exists.
  const fine = { pressExcess: 0, rangeExcess: -0.5, worstRange: ["Boss A (3 kills)"], overshootExcess: 0 };
  assert.ok(!executionLevers(fine, {}, 40).some((x) => /MOVEMENT/.test(x.text)), "negative median -> no movement line");
  const zero = { pressExcess: 0, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  assert.ok(!executionLevers(zero, {}, 40).some((x) => /MOVEMENT/.test(x.text)), "zero median -> no movement line");
  // A real positive loss still fires.
  const real = { pressExcess: 0, rangeExcess: 4.4, worstRange: ["Boss A (3 kills)"], overshootExcess: 0 };
  assert.ok(executionLevers(real, {}, 40).some((x) => /MOVEMENT/.test(x.text)), "positive median -> movement line fires");
});

test("executionLevers: small gap scales down via the headroom cap", () => {
  const execd = { pressExcess: 1.2, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 26, field: 28, pct: 8 } };
  const [press] = executionLevers(execd, rot, 8);       // 8% behind -> cap 0.6*8=5; castEst 4
  assert.ok(press.impact <= 5 && press.impact >= 1);
});

test("executionLevers: high overshoot flips press-faster off the 'not latency' claim", () => {
  const execd = { pressExcess: 2.0, rangeExcess: 0, worstRange: [], overshootExcess: 40 };
  const rot = { castGap: { you: 16, field: 28, pct: 44 } };
  const out = executionLevers(execd, rot, 60);
  assert.match(out[0].text, /input latency/i);          // press-faster now points at latency
  assert.ok(out.some((r) => /INPUT LATENCY/.test(r.text))); // and the latency lever fires
});

test("executionLevers: no press-faster when you out-cast the field (idle heuristic is contradicted)", () => {
  // You can't fire MORE damaging abilities/min than the field (69 vs 65) AND idle
  // more than them. The cast count is harder evidence than the gap heuristic, so
  // press-faster must be suppressed entirely -- the gap is damage-per-cast.
  const execd = { pressExcess: 2.7, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 69, field: 65, pct: 0 } };
  const out = executionLevers(execd, rot, 22);
  assert.ok(!out.some((r) => /PRESS FASTER/.test(r.text)), "no press-faster lever when out-casting the field");
});

test("executionLevers: no press-faster when you idle LESS than peers in range (deficit is movement/mix)", () => {
  // Dysphoric (Feral): pressExcess -2.0 (idles LESS in-range than peers) yet casts
  // 37 vs 42/min. The deficit is movement (the uptime lever) + ability-mix, NOT idle
  // GCDs -- so press-faster must NOT fire, and must NEVER print "you idle ~-2.0s/min
  // MORE" (a flat contradiction of the data). The cast-deficit branch requires
  // non-negative in-range idle.
  const execd = { pressExcess: -2.0, rangeExcess: 4.4, worstRange: ["Boss"], overshootExcess: 0 };
  const rot = { castGap: { you: 37, field: 42, pct: 12 } };
  const out = executionLevers(execd, rot, 60);
  assert.ok(!out.some((r) => /PRESS FASTER/.test(r.text)), "no press-faster when out-pressing peers in range");
  assert.ok(!out.some((r) => /-\d.*MORE than peers/.test(r.text)), "never a negative 'idle MORE' figure");
});

test("executionLevers: cast deficit with ~zero in-range idle reframes off the 'idle MORE' headline", () => {
  // Slow-but-not-idle: you press as much as peers in range (pressExcess ~0) but your
  // damaging-cast rate trails -- micro-gaps, not big pauses. The lever still fires
  // (speedPct>=3) but the headline must not assert "you idle ~0.0s/min MORE".
  const execd = { pressExcess: 0.1, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 50, field: 60, pct: 17 } };
  const [press] = executionLevers(execd, rot, 40);
  assert.ok(press && /PRESS FASTER/.test(press.text), "press-faster still fires on a real cast deficit");
  assert.doesNotMatch(press.text, /idle ~0?\.\ds\/min MORE/, "no spurious '~0s/min MORE idle' claim");
  assert.match(press.text, /in-range idle matches theirs/);
});

test("HEALER: press-faster is suppressed (idle GCDs are correct play), but latency/movement keep firing", () => {
  // A healer with a real cast deficit AND idle time would get "PRESS FASTER" on a
  // damage run -- but holding a global rather than dumping an overheal is right, so
  // it's suppressed. The movement/uptime + input-latency levers still apply.
  const execd = { pressExcess: 2.0, rangeExcess: 2.0, worstRange: ["Boss"], overshootExcess: 40 };
  const rot = { castGap: { you: 16, field: 28, pct: 44 } };
  try {
    setRunMetric("hps");
    const out = executionLevers(execd, rot, 60);
    assert.ok(!out.some((r) => /PRESS FASTER/.test(r.text)), "no press-faster for a healer");
    assert.ok(out.some((r) => /INPUT LATENCY/.test(r.text)), "latency lever still fires");
    assert.ok(out.some((r) => /MOVEMENT/i.test(r.text)), "movement/uptime lever still fires");
  } finally { setRunMetric("dps"); }
  // Same inputs on a DPS run DO produce press-faster (regression guard).
  assert.ok(executionLevers(execd, rot, 60).some((r) => /PRESS FASTER/.test(r.text)));
});

test("HEALER: rotationLevers drops the reactive 'press more' + empowerment, keeps cooldown + talent", () => {
  const rot = {
    abilityIds: {},
    usage: { under: [{ name: "Vivify", you: 11, field: 30, gap: 19 }], over: [] },
    talent: null,                                  // no talent data -> plain under-use (the reactive case)
    cooldowns: [{ name: "Rewind", you: 0.4, field: 1.1, youCasts: 1, fieldCasts: 2.2, pct: 4 }],
    cdUsage: [], perCast: [
      { name: "Vivify", youEmp: 0.1, fieldEmp: 0.4, pct: 6 }],   // would-be empowerment
  };
  try {
    setRunMetric("hps");
    const out = rotationLevers(rot);
    assert.ok(!out.some((r) => /^ROTATION: press/.test(r.text)), "no reactive 'press more heals'");
    assert.ok(!out.some((r) => /EMPOWERMENT/.test(r.text)), "no empowerment lever for a healer");
    assert.ok(out.some((r) => /COOLDOWN: .*Rewind/.test(r.text)), "healing-cooldown lever kept (a valid HPS rec)");
  } finally { setRunMetric("dps"); }
  // DPS run: the reactive press lever fires (regression guard).
  assert.ok(rotationLevers(rot).some((r) => /^ROTATION: press/.test(r.text)));
});

test("executionLevers: a genuine cast deficit still fires press-faster", () => {
  // The guard is narrow: only when you cast >= field. A real deficit still leads.
  const execd = { pressExcess: 2.0, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 16, field: 28, pct: 44 } };
  const [press] = executionLevers(execd, rot, 60);
  assert.match(press.text, /PRESS FASTER/);
});

test("executionLevers: no press-faster when your uptime is already ~99% (no idle to recover)", () => {
  // A 99%-active player with a cast deficit (47 vs 51) can't be idling -- the
  // deficit is ability-mix (defensive/lower-APM GCDs), not idle gaps. Pass active%.
  const execd = { pressExcess: 2.0, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 47, field: 51, pct: 8 } };
  const high = executionLevers(execd, rot, 49, 99.5);
  assert.ok(!high.some((r) => /PRESS FASTER/.test(r.text)), "99.5% active -> no press-faster");
  // Same player but genuinely idle (low active%) -> press-faster fires.
  const low = executionLevers(execd, rot, 49, 90);
  assert.ok(low.some((r) => /PRESS FASTER/.test(r.text)), "90% active -> press-faster fires");
});

test("trinketLevers: fires on a real consensus, sized by it; silent on a split field", async () => {
  // Trinkets are effect-based -- gear.js skips them -- so this lever flags a
  // trinket most ilvl-matched peers run that you lack, as a "sim it" candidate.
  // Near-unanimous (8/8) -> a real lever, sized up.
  const unanimous = { n: 8, trinkets: new Map([[1001, { name: "Field Favorite", count: 8 }]]) };
  const out = await trinketLevers(unanimous, { trinketIds: new Set([2002]), trinkets: ["Yours"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].dim, "Gear");
  assert.match(out[0].text, /TRINKETS:/);
  assert.match(out[0].text, /Field Favorite/);
  assert.match(out[0].text, /8\/8 peers/);
  assert.match(out[0].text, /sim/i);                 // never claims a measured gain
  assert.equal(out[0].impact, 3);                    // share 1.0 -> top size

  // A SPLIT field (lots of people use different trinkets) -> no clear best, silent.
  // No trinket reaches the 60% consensus bar even though you run none of them.
  const split = { n: 10, trinkets: new Map([
    [1001, { name: "A", count: 4 }], [1002, { name: "B", count: 3 }], [1003, { name: "C", count: 3 }],
  ]) };
  assert.equal((await trinketLevers(split, { trinketIds: new Set([9999]), trinkets: ["Mine"] })).length, 0);

  // A slim-but-real majority (6/10) -> fires, but sized DOWN (low confidence).
  const slim = { n: 10, trinkets: new Map([[1001, { name: "D", count: 6 }], [1002, { name: "E", count: 4 }]]) };
  const slimOut = await trinketLevers(slim, { trinketIds: new Set([1002]), trinkets: ["E"] });
  assert.equal(slimOut.length, 1);
  assert.equal(slimOut[0].impact, 1);                // share 0.6 -> smallest size

  // You already run the favorite -> nothing to suggest.
  assert.equal((await trinketLevers(unanimous, { trinketIds: new Set([1001]), trinkets: ["Field Favorite"] })).length, 0);

  // Too small a field sample -> not enough signal, stays silent (no false positive).
  const tiny = { n: 3, trinkets: new Map([[1001, { name: "X", count: 3 }]]) };
  assert.equal((await trinketLevers(tiny, { trinketIds: new Set(), trinkets: [] })).length, 0);
});

test("pickCurrentKill: most recent within the ilvl band, not the stale peak", () => {
  // The classic stale-snapshot bug: a peak-ilvl kill from weeks ago must NOT be
  // read as 'current gear' when a near-peak kill from last night exists -- else
  // enchant/gem fixes made since are hidden.
  const recentNearPeak = pickCurrentKill([
    { ilvl: 290, startTime: 100, boss: "old-peak" },
    { ilvl: 289, startTime: 900, boss: "last-night" },
  ]);
  assert.equal(recentNearPeak.boss, "last-night");
  // But a recent kill from much LOWER gear (outside the band) isn't 'current'.
  const ignoresAltGear = pickCurrentKill([
    { ilvl: 290, startTime: 100, boss: "main" },
    { ilvl: 283, startTime: 900, boss: "alt-or-old-tier" },
  ]);
  assert.equal(ignoresAltGear.boss, "main");
  assert.equal(pickCurrentKill([]), null);
});

test("reconcileImpacts: concrete fixes + residual always sum to the target (the gap)", () => {
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  // over-claim: our sims exceed the headroom -> scale DOWN so they can't claim
  // more DPS than the gap is (this is what shrinks a near-the-field player's list).
  let r = reconcileImpacts([10, 6, 4], 10);
  assert.deepEqual(r.scaled, [5, 3, 2]);
  assert.equal(r.residual, 0);
  assert.equal(sum(r.scaled) + r.residual, 10);
  // under-explain: leftover becomes the residual (further-behind -> bigger residual).
  r = reconcileImpacts([3, 2], 10);
  assert.deepEqual(r.scaled, [3, 2]);
  assert.equal(r.residual, 5);
  assert.equal(sum(r.scaled) + r.residual, 10);
  // no concrete levers: the whole target is residual.
  r = reconcileImpacts([], 8);
  assert.equal(r.residual, 8);
  // comp already covers the gap (target 0): concrete scale to ~0, no residual.
  r = reconcileImpacts([3, 2], 0);
  assert.deepEqual(r.scaled, [0, 0]);
  assert.equal(r.residual, 0);
});

test("isEliteParse: top decile (90th+) marks 'this player isn't the problem'", () => {
  assert.equal(isEliteParse(94), true);
  assert.equal(isEliteParse(90), true);
  assert.equal(isEliteParse(89), false);
  assert.equal(isEliteParse(50), false);
  assert.equal(isEliteParse(null), false);   // unknown -> not elite
});

test("remainderKind: a big remainder for an ELITE player is the gap to top parses, not 'playstyle'", () => {
  // The bug this guards: a 94th-%ile Frost Mage told 86% of their gap is 'how you
  // play the gear worse'. For an elite player it's the distance to the BEST parses
  // at their ilvl (comp + optimal pulls), NOT a personal playstyle deficit.
  assert.equal(remainderKind(86, { elite: true }), "elite");
  assert.equal(remainderKind(86, { elite: false }), "playstyle");
  // A healer's big remainder is HPS-is-damage-bound, not personal playstyle.
  assert.equal(remainderKind(86, { healer: true }), "healer");
  assert.equal(remainderKind(86, { elite: true, healer: true }), "elite");   // elite wins (selection bias applies to healers too)
  // Small remainders are unaffected by elite -- still execution/variance.
  assert.equal(remainderKind(4, { elite: true, underPress: true }), "underpress");
  assert.equal(remainderKind(4, { elite: true, underPress: false }), "small");
  assert.equal(remainderKind(4, { elite: false, underPress: true }), "underpress");
});

test("verdictLever: headlines the ACTUAL biggest lever, not a fixed category precedence", () => {
  // The bug this guards: a Havoc DH with rotation #1 (8%) and a TALENTS swap #4
  // (3%) was told "your biggest lever is a TALENT/BUILD change -- sort that first",
  // contradicting the biggest-first list. The verdict must key off yours[0].
  const rot = { dim: "Rotation", impact: 8, text: "ROTATION: press X more" };
  const talent = { dim: "Rotation", impact: 3, text: "TALENTS: take Y" };
  const gear = { dim: "Gear", impact: 2, text: "GEMS: consolidate" };
  const uptime = { dim: "Execution", impact: 7, text: "UPTIME: stay in melee" };
  // Sorted biggest-first (as renderPrescription receives it).
  assert.equal(verdictLever([rot, uptime, gear, talent]), "rotation");
  // Talent only wins when it's genuinely the top lever.
  assert.equal(verdictLever([talent, gear]), "build");
  // Execution top (uptime/press-faster) is its own verdict, not "everything matches".
  assert.equal(verdictLever([uptime, gear]), "execution");
  assert.equal(verdictLever([gear, talent]), "setup");
  assert.equal(verdictLever([]), "none");
});

test("latencyLever: fires only above the threshold, never below", () => {
  assert.equal(latencyLever({ overshootExcess: 40 }).length, 1);
  assert.match(latencyLever({ overshootExcess: 40 })[0].text, /SpellQueueWindow/);
  assert.equal(latencyLever({ overshootExcess: 20 }).length, 0);
  assert.equal(latencyLever(null).length, 0);
});

test("gemLever: actionable when your primary gem differs from the field's", () => {
  const gf = { gems: { yourGems: new Map([[111, 3]]), yourVariety: 1, fieldTop: [[999, 40]], fieldVarietyMed: 1 } };
  const [g] = gemLever(gf);
  assert.match(g.text, /^GEMS:/);
  assert.match(g.text, /item=999/);                     // links the field's gem
});

test("gemLever links the field gem by NAME, not a generic phrase", () => {
  const gf = { gems: { yourGems: new Map([[111, 3]]), yourVariety: 1, fieldTop: [[999, 40]], fieldTopName: "Culminating Blasphemite", fieldVarietyMed: 1 } };
  const [g] = gemLever(gf);
  assert.match(g.text, /\[Culminating Blasphemite\]\(https:\/\/www\.wowhead\.com\/item=999\)/);
  assert.doesNotMatch(g.text, /the field's primary gem/);   // not the generic phrase
});

test("gemLever: wrong-primary w/ MATCHING variety doesn't cite the contradictory count", () => {
  // you run 2 colors, field runs 2 -- same variety, just a different main gem.
  const gf = { gems: { yourGems: new Map([[111, 2], [222, 1]]), yourVariety: 2, fieldTop: [[999, 40]], fieldVarietyMed: 2 } };
  const [g] = gemLever(gf);
  assert.match(g.text, /^GEMS:/);
  assert.doesNotMatch(g.text, /2 gem colors vs the field's 2/);  // the nonsensical line
  assert.doesNotMatch(g.text, /splitting stats/);                // not an over-variety case
});

test("gemLever: flags over-variety even when your top gem matches", () => {
  const gf = { gems: { yourGems: new Map([[999, 2], [111, 1], [222, 1]]), yourVariety: 3, fieldTop: [[999, 40]], fieldVarietyMed: 1 } };
  const [g] = gemLever(gf);
  assert.match(g.text, /splitting stats/);
});

test("gemLever: silent when your gems already match the field", () => {
  const gf = { gems: { yourGems: new Map([[999, 3]]), yourVariety: 1, fieldTop: [[999, 40]], fieldVarietyMed: 1 } };
  assert.equal(gemLever(gf).length, 0);
  assert.equal(gemLever(null).length, 0);
  assert.equal(gemLever({ gems: null }).length, 0);
});

test("DPS/COMP/INFO build impact and label together (no drift)", () => {
  assert.deepEqual(DPS(3), { impact: 3, label: "~3% DPS" });
  assert.deepEqual(DPS(1, 3), { impact: 2, label: "~1-3% DPS" });   // impact = midpoint
  assert.deepEqual(DPS(2, 4), { impact: 3, label: "~2-4% DPS" });
  assert.deepEqual(COMP(5), { impact: 5, label: "~5% comp" });
  assert.deepEqual(INFO, { impact: 0, label: "info" });
});

test("rxHeadline keeps the keyword + first clause, trimming the detail", () => {
  assert.equal(rxHeadline("ROTATION: press Ravage (peers 5.5/min vs your 0.0) more; you over-press Thrash"),
    "ROTATION: press Ravage");
  assert.equal(rxHeadline("PRESS FASTER (every boss): you idle ~4.8s/min MORE"), "PRESS FASTER");
});

test("sorting by impact is biggest-DPS-first and the labels follow", () => {
  const rx = [
    { ...DPS(1, 2), text: "proc" },   // 1.5
    { ...DPS(2), text: "flask" },     // 2
    { ...INFO, text: "crit not actionable" }, // 0
    { ...DPS(5), text: "press faster" },      // 5
    { ...DPS(3), text: "gear swap" },         // 3
  ];
  rx.sort((a, b) => b.impact - a.impact);
  assert.deepEqual(rx.map((r) => r.text),
    ["press faster", "gear swap", "flask", "proc", "crit not actionable"]);
  for (let i = 1; i < rx.length; i++) assert.ok(rx[i].impact <= rx[i - 1].impact); // non-increasing
});

// The embellishment advice is ONE finding that names the specific items to craft
// -- not a "fill a slot" line plus a separate "match a combo" line.
const EC = (over = {}) => ({
  yourCombo: [], yourRank: null, fieldN: 18,
  topCombos: [[["Back", "Wrist"], 6]],
  recommended: [["Back", "Writhing Armor Banding", 6], ["Wrist", "Elemental Lariat", 5]],
  ...over,
});

test("embellishments: 0/2 -> one finding naming both items to craft", () => {
  const r = embellishmentRx({ embellishedSlots: [], embCompare: EC() });
  assert.ok(r, "should produce a finding");
  assert.equal(r.dim, "Gear");
  assert.equal(r.label, "~2-4% DPS");
  assert.match(r.text, /Writhing Armor Banding \(Back\) \+ Elemental Lariat \(Wrist\)/);
  assert.match(r.text, /#1 field combo, 6\/18/);
});

test("embellishments: 1/2 -> only names the slot you're missing", () => {
  const r = embellishmentRx({ embellishedSlots: ["Back"], embCompare: EC() });
  assert.ok(r);
  assert.match(r.text, /Elemental Lariat \(Wrist\)/);
  assert.doesNotMatch(r.text, /Back\)/, "shouldn't tell you to re-craft the slot you already have");
});

test("embellishments: full but suboptimal combo -> switch to the top items", () => {
  const r = embellishmentRx({
    embellishedSlots: ["Belt", "Feet"],
    embCompare: EC({ yourCombo: ["Belt", "Feet"] }),
  });
  assert.ok(r);
  assert.match(r.text, /switch to/);
  assert.match(r.text, /Writhing Armor Banding \(Back\) \+ Elemental Lariat \(Wrist\)/);
});

test("embellishments: already running a top combo -> no finding", () => {
  const r = embellishmentRx({
    embellishedSlots: ["Back", "Wrist"],
    embCompare: EC({ yourCombo: ["Back", "Wrist"], yourRank: [1, 6] }),
  });
  assert.equal(r, null);
});

test("embellishments: you OWN the #1 items (slot keyed differently) -> no finding", () => {
  // The "but I have that" bug: you run the field's #1 items, but the field keys
  // the combo by a slot label yours doesn't match (Finger1 vs Finger2), so
  // yourRank is null. runsTopItems + an empty recommended must suppress the nag.
  const r = embellishmentRx({
    embellishedSlots: ["Back", "Wrist"],
    embCompare: EC({ yourCombo: ["Back", "Wrist"], yourRank: null, runsTopItems: true, recommended: [] }),
  });
  assert.equal(r, null);
});
