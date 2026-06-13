// Pure, class-agnostic rotation helpers: empowered-hit detection and opener
// extraction. No ability names, no class assumptions, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { empoweredCount, openerSequence, fieldCastRates, usageDivergence } = await import("../docs/rotation.js");

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
