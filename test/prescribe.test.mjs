// The prescription's whole point is one list of changes ordered "biggest DPS
// first". A finding is { dim, impact, label, text }: impact (a number) drives the
// order, label is the matching display string, and DPS()/COMP()/INFO build the
// two together so they can never drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { DPS, COMP, INFO, embellishmentRx, rxHeadline } = await import("../docs/prescribe.js");

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
  your_combo: [], your_rank: null, field_n: 18,
  top_combos: [[["Back", "Wrist"], 6]],
  recommended: [["Back", "Writhing Armor Banding", 6], ["Wrist", "Elemental Lariat", 5]],
  ...over,
});

test("embellishments: 0/2 -> one finding naming both items to craft", () => {
  const r = embellishmentRx({ embellishedSlots: [], emb_compare: EC() });
  assert.ok(r, "should produce a finding");
  assert.equal(r.dim, "Gear");
  assert.equal(r.label, "~2-4% DPS");
  assert.match(r.text, /Writhing Armor Banding \(Back\) \+ Elemental Lariat \(Wrist\)/);
  assert.match(r.text, /#1 field combo, 6\/18/);
});

test("embellishments: 1/2 -> only names the slot you're missing", () => {
  const r = embellishmentRx({ embellishedSlots: ["Back"], emb_compare: EC() });
  assert.ok(r);
  assert.match(r.text, /Elemental Lariat \(Wrist\)/);
  assert.doesNotMatch(r.text, /Back\)/, "shouldn't tell you to re-craft the slot you already have");
});

test("embellishments: full but suboptimal combo -> switch to the top items", () => {
  const r = embellishmentRx({
    embellishedSlots: ["Belt", "Feet"],
    emb_compare: EC({ your_combo: ["Belt", "Feet"] }),
  });
  assert.ok(r);
  assert.match(r.text, /switch to/);
  assert.match(r.text, /Writhing Armor Banding \(Back\) \+ Elemental Lariat \(Wrist\)/);
});

test("embellishments: already running a top combo -> no finding", () => {
  const r = embellishmentRx({
    embellishedSlots: ["Back", "Wrist"],
    emb_compare: EC({ your_combo: ["Back", "Wrist"], your_rank: [1, 6] }),
  });
  assert.equal(r, null);
});
