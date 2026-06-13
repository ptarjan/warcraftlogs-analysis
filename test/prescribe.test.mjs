// The prescription's whole point is one list of changes ordered "biggest DPS
// first". impactScore drives that order, so it must match the displayed labels.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { impactScore, embellishmentRx, dimensionOf, rxHeadline } = await import("../docs/prescribe.js");

test("dimensionOf groups each finding under the analysis it came from", () => {
  assert.equal(dimensionOf("PRESS FASTER (every boss): you idle ..."), "Execution");
  assert.equal(dimensionOf("UPTIME on specific fights: ..."), "Execution");
  assert.equal(dimensionOf("ROTATION: press Ravage ..."), "Rotation");
  assert.equal(dimensionOf("PROC: you land ..."), "Rotation");
  assert.equal(dimensionOf("FLASK: you ran none ..."), "Setup");
  assert.equal(dimensionOf("COMBAT POTION: you used none ..."), "Setup");
  assert.equal(dimensionOf("AUGMENT RUNE: you ran none ..."), "Setup");
  assert.equal(dimensionOf("WEAPON OIL: you ran none ..."), "Setup");
  assert.equal(dimensionOf("ENCHANTS: you're missing enchants on Weapon ..."), "Setup");
  assert.equal(dimensionOf("BUFF (comp): top parses run ..."), "Comp");
  assert.equal(dimensionOf("ROUTING: top parses put ..."), "Comp");
  assert.equal(dimensionOf("HASTE via Neck: replace ..."), "Gear");   // the catch-all
  assert.equal(dimensionOf("EMBELLISHMENTS: you run 0/2 ..."), "Gear");
});

test("rxHeadline keeps the keyword + first clause, trimming the detail", () => {
  assert.equal(rxHeadline("ROTATION: press Ravage (peers 5.5/min vs your 0.0) more; you over-press Thrash"),
    "ROTATION: press Ravage");
  assert.equal(rxHeadline("PRESS FASTER (every boss): you idle ~4.8s/min MORE"), "PRESS FASTER");
});

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

// The embellishment advice is ONE finding that names the specific items to craft
// -- not a "fill a slot" line plus a separate "match a combo" line.
const EC = (over = {}) => ({
  your_combo: [], your_rank: null, field_n: 18,
  top_combos: [[["Back", "Wrist"], 6]],
  recommended: [["Back", "Writhing Armor Banding", 6], ["Wrist", "Elemental Lariat", 5]],
  ...over,
});

test("embellishments: 0/2 -> one finding naming both items to craft", () => {
  const r = embellishmentRx({ embellishedSlots: [], emb_compare: EC() });
  assert.ok(r, "should produce a finding");
  assert.equal(r[1], "~2-4% DPS");
  assert.match(r[2], /Writhing Armor Banding \(Back\) \+ Elemental Lariat \(Wrist\)/);
  assert.match(r[2], /#1 field combo, 6\/18/);
});

test("embellishments: 1/2 -> only names the slot you're missing", () => {
  const r = embellishmentRx({ embellishedSlots: ["Back"], emb_compare: EC() });
  assert.ok(r);
  assert.match(r[2], /Elemental Lariat \(Wrist\)/);
  assert.doesNotMatch(r[2], /Back\)/, "shouldn't tell you to re-craft the slot you already have");
});

test("embellishments: full but suboptimal combo -> switch to the top items", () => {
  const r = embellishmentRx({
    embellishedSlots: ["Belt", "Feet"],
    emb_compare: EC({ your_combo: ["Belt", "Feet"] }),
  });
  assert.ok(r);
  assert.match(r[2], /switch to/);
  assert.match(r[2], /Writhing Armor Banding \(Back\) \+ Elemental Lariat \(Wrist\)/);
});

test("embellishments: already running a top combo -> no finding", () => {
  const r = embellishmentRx({
    embellishedSlots: ["Back", "Wrist"],
    emb_compare: EC({ your_combo: ["Back", "Wrist"], your_rank: [1, 6] }),
  });
  assert.equal(r, null);
});
