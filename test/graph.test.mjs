// graph.js: the phase-ALIGNMENT math (the part most likely to regress). Pure unit
// tests over buildCurveComparison -- no network -- so the "align phases so a faster
// phase doesn't smear the comparison" behavior is locked in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCurveComparison } from "../docs/graph.js";

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
