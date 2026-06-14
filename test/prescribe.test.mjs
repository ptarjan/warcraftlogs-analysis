// The prescription's whole point is one list of changes ordered "biggest DPS
// first". A finding is { dim, impact, label, text }: impact (a number) drives the
// order, label is the matching display string, and DPS()/COMP()/INFO build the
// two together so they can never drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { DPS, COMP, INFO } = await import("../docs/core.js");          // shared Finding currency
const { rxHeadline, executionLevers, latencyLever } = await import("../docs/prescribe.js");
const { embellishmentRx, gemLever } = await import("../docs/gear.js");          // gear-domain lever

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

test("executionLevers: a genuine cast deficit still fires press-faster", () => {
  // The guard is narrow: only when you cast >= field. A real deficit still leads.
  const execd = { pressExcess: 2.0, rangeExcess: 0, worstRange: [], overshootExcess: 0 };
  const rot = { castGap: { you: 16, field: 28, pct: 44 } };
  const [press] = executionLevers(execd, rot, 60);
  assert.match(press.text, /PRESS FASTER/);
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
