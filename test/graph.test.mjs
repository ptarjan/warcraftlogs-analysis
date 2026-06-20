// graph.js: the phase-ALIGNMENT math (the part most likely to regress). Pure unit
// tests over buildCurveComparison -- no network -- so the "align phases so a faster
// phase doesn't smear the comparison" behavior is locked in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCurveComparison, graphLevers } from "../docs/graph.js";

// A flat-per-phase curve: value `levels[p]` for the fraction-of-fight in phase p.
function curve(fracs, levels, n = 60) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    let p = 0;
    while (p + 1 < fracs.length && f >= fracs[p + 1]) p++;
    arr.push(levels[p]);
  }
  return arr;
}

test("phase-aligns curves whose phase boundaries fall at DIFFERENT fight-%", () => {
  // 3 phases. The field is strong in every phase; YOU crater in phase 2. Critically,
  // your phase boundaries (0/.30/.65) differ from the field's (0/.20/.50) -- a raw
  // fraction-of-fight overlay would smear phase 2 against phases 1 and 3. Alignment
  // must still pin the dip to phase 2.
  const you = { phases: [0, 0.30, 0.65], dps: curve([0, 0.30, 0.65], [100, 25, 100]) };
  const peers = Array.from({ length: 4 }, () => ({
    phases: [0, 0.20, 0.50], dps: curve([0, 0.20, 0.50], [100, 100, 100]), overall: 100,
  }));
  const r = buildCurveComparison(you, peers);
  assert.ok(r, "should produce a comparison");
  assert.equal(r.aligned, true, "same phase count across kills -> aligned");
  assert.equal(r.bounds.length, 2, "3 phases -> 2 interior boundaries");
  assert.ok(r.worst, "a dip exists");
  assert.equal(r.worst.phase, 2, "the dip is correctly attributed to PHASE 2");
  assert.equal(r.worst.nPhases, 3);
  assert.ok(r.worst.deficit > 0.5, `phase-2 deficit should be large, got ${r.worst.deficit}`);
  assert.ok(r.worst.gainPct >= 1, `the dip should be sized in DPS%, got ${r.worst.gainPct}`);
  // fracStart/fracEnd map the dip back into YOUR fight (phase 2 is .30-.65 of your kill).
  assert.ok(r.worst.fracStart >= 0.25 && r.worst.fracEnd <= 0.70, `dip maps to your phase-2 window, got ${r.worst.fracStart}-${r.worst.fracEnd}`);
});

test("no dip when the FIELD also drops there (inherent low-damage phase, not gainable)", () => {
  // You crater in phase 2 -- but so does the field (everyone does less here). It's the
  // phase, not you, so nothing to flag.
  const you = { phases: [0, 0.30, 0.65], dps: curve([0, 0.30, 0.65], [100, 25, 100]) };
  const peers = Array.from({ length: 4 }, () => ({
    phases: [0, 0.30, 0.65], dps: curve([0, 0.30, 0.65], [100, 25, 100]), overall: 100,
  }));
  const r = buildCurveComparison(you, peers);
  assert.ok(r);
  assert.ok(!r.worst || r.worst.deficit < 0.12, "field also drops -> no gainable hole flagged");
});

test("graphLevers: a cooldown-cause dip is a sized DPS lever, idle is a 0-impact locator", () => {
  const base = { boss: "Boss", unit: "DPS", isHealer: false };
  const wBase = { deficit: 0.3, gainPct: 4, phase: 5, center: 0.8, youTypical: 60000, youWindow: 42000, fieldWindow: 37000 };
  const cd = graphLevers({ ...base, worst: { ...wBase, cause: "cooldown", cpmRatio: 1.0 } });
  assert.equal(cd.length, 1);
  assert.equal(cd[0].dim, "Execution");
  assert.equal(cd[0].kind, "PHASE_DIP");
  assert.equal(cd[0].impact, 4, "cooldown dip carries the sized DPS impact");
  assert.match(cd[0].text, /Phase 5/);
  assert.match(cd[0].text, /cooldown/i);
  // OWN-BASELINE framing -- vs your own typical, never "X% under the field".
  assert.match(cd[0].text, /your own/);
  assert.doesNotMatch(cd[0].text, /under the field|less than the field/i);

  const idle = graphLevers({ ...base, worst: { ...wBase, cause: "idle", cpmRatio: 0.4 } });
  assert.equal(idle.length, 1);
  assert.equal(idle[0].impact, 4, "a LOCALIZED idle hole is sized (the whole-fight press-faster lever is silent for an active player)");
  assert.match(idle[0].text, /quiet|coasting|rotation going/i);
});

test("graphLevers: names the culprit ability / the mistimed cooldown, or honestly bows out", () => {
  const base = { boss: "Boss", unit: "DPS", isHealer: false };
  const wBase = { deficit: 0.3, gainPct: 4, phase: 5, center: 0.8, youTypical: 60000, youWindow: 42000, fieldWindow: 50000, cause: "cooldown" };
  // One ability dominates the drop -> name it ("press THAT").
  const named = graphLevers({ ...base, worst: { ...wBase, culprit: { name: "Rising Sun Kick", normalK: 12, windowK: 3 } } });
  assert.equal(named[0].impact, 4);
  assert.match(named[0].text, /Rising Sun Kick/);
  assert.match(named[0].text, /3k vs ~12k/);
  // A self damage-cooldown is genuinely mistimed -> NAME it (from the log) + sized lever.
  const cd = graphLevers({ ...base, worst: { ...wBase, uniform: true, uniformPct: 30, cooldown: { name: "Invoke Niuzao", inPct: 5, outPct: 35, drop: 0.3 } } });
  assert.equal(cd[0].impact, 4);
  assert.match(cd[0].text, /Invoke Niuzao/);
  assert.match(cd[0].text, /5% of Phase 5 vs 35%/);
  assert.match(cd[0].text, /shift it/i);
  // Cooldowns DO cover the window -> NOT timing; honest INFO (impact 0), not a fake lever.
  const cover = graphLevers({ ...base, worst: { ...wBase, uniform: true, uniformPct: 30, cdsCover: true } });
  assert.equal(cover[0].impact, 0, "no gainable personal lever -> INFO, not a sized DPS item");
  assert.match(cover[0].text, /cooldowns DO cover|not.*timing/i);
  assert.match(cover[0].text, /cleave|Bloodlust|raid cooldown|fewer targets/i);
});

test("graphLevers: labels a CYCLING boss's dip by phase id + occurrence, not segment ordinal", () => {
  const base = { boss: "Chimaerus", unit: "DPS", isHealer: false };
  // 3rd segment of a 1,2,1,2 boss -> phase id 1, its 2nd occurrence (NOT "Phase 3").
  const w = { deficit: 0.4, gainPct: 8, phase: 3, phaseId: 1, phaseOcc: 2, phaseTotal: 2, center: 0.8,
    youTypical: 42000, youWindow: 24000, fieldWindow: 40000, cause: "idle", cpmRatio: 0.6 };
  const lev = graphLevers({ ...base, worst: w });
  assert.match(lev[0].text, /Phase 1 \(2nd time\)/);
  assert.doesNotMatch(lev[0].text, /Phase 3/);
});

test("graphLevers: a death-contaminated dip is NOT a press-lever", () => {
  const base = { boss: "Boss", unit: "DPS", isHealer: false };
  const wBase = { deficit: 0.4, gainPct: 10, phase: 3, center: 0.85, youTypical: 42000, youWindow: 20000, fieldWindow: 41000, cause: "idle", cpmRatio: 0.66 };
  // Same dip, but you DIED in the window -> survival, not rotation -> no lever.
  assert.deepEqual(graphLevers({ ...base, worst: { ...wBase, death: { atPct: 89 } } }), []);
  // Without the death it IS a sized lever (sanity).
  assert.equal(graphLevers({ ...base, worst: wBase })[0].impact, 10);
});

test("graphLevers: nothing to add when there's no real dip, or for healers/skips", () => {
  assert.deepEqual(graphLevers({ boss: "B", worst: { deficit: 0.05, gainPct: 0 } }), []);
  assert.deepEqual(graphLevers({ boss: "B", isHealer: true, worst: { deficit: 0.3, gainPct: 4, cause: "cooldown" } }), []);
  assert.deepEqual(graphLevers({ skip: "support" }), []);
  assert.deepEqual(graphLevers(null), []);
});

test("falls back to fight-progress overlay when phase counts differ", () => {
  const you = { phases: [0, 0.3, 0.65], dps: curve([0, 0.3, 0.65], [100, 80, 100]) };
  // Peers have a DIFFERENT number of phases -> can't align -> whole-fight resample.
  const peers = Array.from({ length: 3 }, () => ({
    phases: [0, 0.5], dps: curve([0, 0.5], [100, 100]), overall: 100,
  }));
  const r = buildCurveComparison(you, peers);
  assert.ok(r);
  assert.equal(r.aligned, false, "mismatched phase counts -> not aligned");
  assert.equal(r.bounds.length, 0, "no phase dividers when unaligned");
  assert.ok(r.worst == null || r.worst.phase === undefined, "no phase label when unaligned");
});

test("needs at least two peers to draw a band", () => {
  const you = { phases: [0], dps: curve([0], [100]) };
  assert.equal(buildCurveComparison(you, [{ phases: [0], dps: curve([0], [100]), overall: 100 }]), null);
  assert.equal(buildCurveComparison(null, []), null);
});

test("a player at/above the field shows no dip and a high above-band share", () => {
  // You match the field everywhere (single phase) -> no window trails it.
  const mk = () => ({ phases: [0], dps: curve([0, 0.5], [100, 120]), overall: 110 });
  const you = mk();
  const peers = [mk(), mk(), mk()];
  const r = buildCurveComparison(you, peers);
  assert.ok(r);
  assert.ok(!r.worst || r.worst.deficit < 0.12, "no meaningful dip when you track the field");
  assert.ok(r.bandBelow <= 0.5, "not mostly below the band");
});
