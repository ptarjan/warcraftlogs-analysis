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

test("graphLevers: a cooldown-cause dip is a sized DPS lever, idle is a 0-impact locator", () => {
  const base = { boss: "Boss", unit: "DPS", isHealer: false };
  const wBase = { deficit: 0.3, gainPct: 4, phase: 5, center: 0.8, youTypical: 60000, youWindow: 42000 };
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
  assert.equal(idle[0].impact, 0, "an idle dip is INFO (the lost-GCD lever already sizes it)");
  assert.match(idle[0].text, /idle|coast|quiet|rotation going/i);
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
