// The prescription's whole point is one list of changes ordered "biggest DPS
// first". impactScore drives that order, so it must match the displayed labels.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { impactScore } = await import("../docs/prescribe.js");

test("impactScore reads the displayed % (midpoint of ranges)", () => {
  assert.equal(impactScore("~3% DPS"), 3);
  assert.equal(impactScore("~1-3% DPS"), 2);   // midpoint
  assert.equal(impactScore("~2-4% DPS"), 3);
  assert.equal(impactScore("info"), 0);
});

test("sorting by impactScore is biggest-DPS-first and matches the labels", () => {
  const rx = [
    [-1.0, "~1-2% DPS", "proc"],          // 1.5
    [-2.5, "~2% DPS", "flask"],           // 2
    [0, "info", "crit not actionable"],   // 0
    [-9, "~5% DPS", "press faster"],      // 5
    [-2, "~3% DPS", "gear swap"],         // 3
  ];
  rx.sort((a, b) => impactScore(b[1]) - impactScore(a[1]));
  const order = rx.map((r) => r[2]);
  assert.deepEqual(order, ["press faster", "gear swap", "flask", "proc", "crit not actionable"]);
  // labels are non-increasing
  const scores = rx.map((r) => impactScore(r[1]));
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] <= scores[i - 1]);
});
