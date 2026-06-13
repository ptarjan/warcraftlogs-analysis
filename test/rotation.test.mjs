// Pure, class-agnostic rotation helpers: empowered-hit detection and opener
// extraction. No ability names, no class assumptions, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { empoweredCount, openerSequence } = await import("../docs/rotation.js");

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
