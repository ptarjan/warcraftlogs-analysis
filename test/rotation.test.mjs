// Pure rotation logic: opener extraction, effective-cooldown estimation, and
// priority-miss ("wrong button") counting. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { effectiveCooldown, priorityMisses, openerSequence } = await import("../docs/rotation.js");

test("effectiveCooldown finds the gap floor, ignoring an early recast", () => {
  // Keg Smash mostly every ~8s, with one tight 5s outlier.
  const ts = [0, 8000, 16000, 21000, 29000, 37000];
  const cd = effectiveCooldown(ts);
  assert.ok(cd >= 5000 && cd <= 8000, `cd ${cd} should sit near the floor`);
  assert.equal(effectiveCooldown([1000]), Infinity); // single cast => unknown
});

test("priorityMisses flags fillers cast while Keg Smash was available", () => {
  const fillers = new Set(["Tiger Palm"]);
  const watch = [{ name: "Keg Smash", cd: 8000 }];
  // KS at 0; at 9000 KS is back up but a Tiger Palm is cast -> 1 miss.
  // At 2000 KS still on CD, Tiger Palm is correct -> not a miss.
  const casts = [
    { t: 0, name: "Keg Smash" },
    { t: 2000, name: "Tiger Palm" },   // KS on CD: fine
    { t: 9000, name: "Tiger Palm" },   // KS available: MISS
    { t: 9500, name: "Keg Smash" },
  ];
  const r = priorityMisses(casts, fillers, watch);
  assert.equal(r.fillers, 2);
  assert.equal(r.misses, 1);
});

test("priorityMisses: clean play has zero misses", () => {
  const casts = [
    { t: 0, name: "Keg Smash" },
    { t: 1500, name: "Tiger Palm" },
    { t: 3000, name: "Blackout Kick" },
    { t: 8200, name: "Keg Smash" },   // refreshed right on cooldown
    { t: 9700, name: "Tiger Palm" },
  ];
  const r = priorityMisses(casts, new Set(["Tiger Palm"]), [{ name: "Keg Smash", cd: 8000 }]);
  assert.equal(r.misses, 0);
});

test("openerSequence takes the first N casts within the window", () => {
  const casts = [
    { t: 0, name: "Keg Smash" }, { t: 1000, name: "Breath of Fire" },
    { t: 2000, name: "Blackout Kick" }, { t: 25000, name: "Tiger Palm" },
  ];
  assert.deepEqual(openerSequence(casts, 20000, 8),
    ["Keg Smash", "Breath of Fire", "Blackout Kick"]); // the 25s cast is excluded
  assert.deepEqual(openerSequence(casts, 20000, 2),
    ["Keg Smash", "Breath of Fire"]); // capped at n
});
