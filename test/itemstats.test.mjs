// The Wowhead tooltip parsing in gear.js (secondary stats, embellished, unique,
// item level) is the most regression-prone code -- it broke repeatedly during
// development. These lock in its behavior against canned tooltips.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage, mockFetch, tooltip } from "./helpers.mjs";

installLocalStorage();

test("priorityGain: NET gain over your current item, not the candidate's gross stat", async () => {
  const { priorityGain } = await import("../docs/gear.js");
  // The real regression (Solex): a 190-mastery ring swapped for a 247-mastery one gains
  // 57, NOT 247. Gross over-summed "+N total" (714 vs the honest 524) + over-sized it.
  assert.equal(priorityGain(247, 190), 57);
  // A swap onto a 0-priority (crit-itemized) item: net == gross (the common case).
  assert.equal(priorityGain(260, 0), 260);
  // Defensive: missing values treated as 0.
  assert.equal(priorityGain(126, undefined), 126);
  assert.equal(priorityGain(undefined, 50), -50);
});

test("statValueScore: prices a swap from the field's measured per-rating value, not the sim constant", async () => {
  const { statValueScore } = await import("../docs/gear.js");
  // Field: peers who stack crit do 6% more, across a 3000-rating spread -> 0.002%/
  // rating. A +260 crit swap prices at ~0.52% raw, then HALVED for the better-player
  // confound (FIELD_DELTA_CONFOUND) -> ~0.26% -> rounds to <1%, basis measured.
  const sv = { pct: 6, perRating: 6 / 3000, nHave: 6, nNot: 5 };
  const s = statValueScore(260, sv);
  assert.equal(s.label, "~<1% DPS");
  assert.ok(Math.abs(s.impact - 0.26) < 0.01);
});

test("statValueScore: caps a single swap at the whole stat-spread value (and 5%), then damps the confound", async () => {
  const { statValueScore } = await import("../docs/gear.js");
  // A huge gain can't claim more than the field's measured spread value (4%), and
  // that 4% is then halved for the better-player confound -> 2%.
  const s = statValueScore(99999, { pct: 4, perRating: 1, nHave: 6, nNot: 6 });
  assert.equal(s.impact, 2);
});

test("statValueScore: null when the field gave no counterfactual (caller keeps the est)", async () => {
  const { statValueScore } = await import("../docs/gear.js");
  assert.equal(statValueScore(200, null), null);
  assert.equal(statValueScore(200, { pct: 5, perRating: 0 }), null);
});

test("parses crit/vers, embellished, unique, ilvl from a crafted neck", async () => {
  globalThis.fetch = mockFetch([
    ["wowhead", () => tooltip("Masterwork Sin'dorei Amulet",
      "<!--ilvl-->289 +147 Critical Strike +147 Versatility " +
      "Unique-Equipped: Embellished (2)")],
  ]);
  const { itemStats } = await import("../docs/gear.js");
  const s = await itemStats(240950, [12214, 13667]);
  assert.equal(s.crit, 147);
  assert.equal(s.vers, 147);
  assert.equal(s.haste, 0);
  assert.equal(s.mastery, 0);
  assert.equal(s.ilvl, 289);
  assert.equal(s.embellished, true);
  assert.equal(s.unique, true);
});

test("a plain crit ring: unique but not embellished", async () => {
  globalThis.fetch = mockFetch([
    ["wowhead", () => tooltip("Signet of the Starved Beast",
      "<!--ilvl-->289 +238 Critical Strike +65 Versatility Unique-Equipped")],
  ]);
  const { itemStats } = await import("../docs/gear.js");
  const s = await itemStats(249336, []);
  assert.equal(s.crit, 238);
  assert.equal(s.embellished, false);
  assert.equal(s.unique, true);
});

test("a mastery/vers belt has zero crit", async () => {
  globalThis.fetch = mockFetch([
    ["wowhead", () => tooltip("Twisted Twilight Sash", "+85 Mastery +39 Versatility")],
  ]);
  const { itemStats } = await import("../docs/gear.js");
  const s = await itemStats(249314, []);
  assert.equal(s.crit, 0);
  assert.equal(s.mastery, 85);
  assert.equal(s.vers, 39);
});

test("parses drop source + chance from the tooltip", async () => {
  globalThis.fetch = mockFetch([
    ["wowhead", () => tooltip("Soulletting Ruby",
      "<!--ilvl-->37 +8 Intellect" +
      '<div class="whtt-extra whtt-droppedby">Dropped by: Kul\'tharok</div>' +
      '<div class="whtt-extra whtt-dropchance">Drop Chance: 10.25%</div>')],
  ]);
  const { itemStats } = await import("../docs/gear.js");
  const s = await itemStats(178809, []);
  assert.equal(s.source, "Kul'tharok");
  assert.equal(s.dropChance, "10.25%");
  assert.equal(s.crafted, false);
});

test("an embellished item with no drop source is flagged crafted", async () => {
  globalThis.fetch = mockFetch([
    ["wowhead", () => tooltip("Adherent's Silken Shroud",
      "<!--ilvl-->723 +200 Haste Embellished")],
  ]);
  const { itemStats } = await import("../docs/gear.js");
  const s = await itemStats(222820, []);
  assert.equal(s.embellished, true);
  assert.equal(s.source, null);
  assert.equal(s.crafted, true);
});

const ITEMXML = (id, sourcemore) =>
  `<wowhead><item id="${id}"><json><![CDATA["id":${id},"sourcemore":${JSON.stringify(sourcemore)}]]></json></item></wowhead>`;

test("itemInstance: resolves the drop's zone id to an instance name", async () => {
  globalThis.fetch = mockFetch([
    ["item=251093", { text: ITEMXML(251093, [{ n: "Corewarden Nysarra", t: 1, ti: 254227, z: 16573 }]) }],
    ["tooltip/zone/16573", { json: { name: "Nexus-Point Xenas" } }],
  ]);
  const { itemInstance } = await import("../docs/gear.js");
  assert.equal(await itemInstance(251093, "Corewarden Nysarra"), "Nexus-Point Xenas");
});

test("itemInstance: uses the only zoned source when none names the boss", async () => {
  globalThis.fetch = mockFetch([
    ["item=249368", { text: ITEMXML(249368, [{ z: 16340 }]) }],
    ["tooltip/zone/16340", { json: { name: "The Voidspire" } }],
  ]);
  const { itemInstance } = await import("../docs/gear.js");
  assert.equal(await itemInstance(249368, "Alleria Windrunner"), "The Voidspire");
});

test("itemInstance: when the item lists only the boss NPC, the NPC's map.zone names the instance", async () => {
  // sourcemore has the boss NPC (ti) but NO zone id -> resolve via the NPC tooltip.
  globalThis.fetch = mockFetch([
    ["item=300001", { text: ITEMXML(300001, [{ n: "Emberdawn", t: 1, ti: 240999 }]) }],
    ["npc/240999", { json: { name: "Emberdawn", map: { zone: 16555 } } }],
    ["tooltip/zone/16555", { json: { name: "Windrunner Spire" } }],
  ]);
  const { itemInstance } = await import("../docs/gear.js");
  assert.equal(await itemInstance(300001, "Emberdawn"), "Windrunner Spire");
});

test("itemInstance: crafted/sourceless item -> null", async () => {
  globalThis.fetch = mockFetch([
    ["item=222820", { text: ITEMXML(222820, []) }],
  ]);
  const { itemInstance } = await import("../docs/gear.js");
  assert.equal(await itemInstance(222820, null), null);
});

test("sourceText: leads with the instance, falls back to the boss", async () => {
  const { sourceText } = await import("../docs/gear.js");
  assert.equal(sourceText("Alleria Windrunner", "Windrunner Spire", "15%"),
    " -- dropped in Windrunner Spire (15%)");
  assert.equal(sourceText("Emberdawn", null, null), " -- dropped by Emberdawn");
  assert.equal(sourceText(null, "Windrunner Spire", null), " -- dropped in Windrunner Spire");
  assert.equal(sourceText(null, null, null), "");
});

test("result is cached: identical lookup does not refetch", async () => {
  const fx = mockFetch([["wowhead", () => tooltip("X", "+10 Haste")]]);
  globalThis.fetch = fx;
  const { itemStats } = await import("../docs/gear.js");
  const a = await itemStats(99001, []);
  const b = await itemStats(99001, []);
  assert.equal(a.haste, 10);
  assert.equal(b.haste, 10);
  assert.equal(fx.calls.length, 1, "second lookup should be served from cache");
});

test("different bonus IDs are cached separately (stats vary per instance)", async () => {
  const fx = mockFetch([["wowhead", (u) =>
    tooltip("Crafted", u.includes("bonus=1") ? "+50 Critical Strike" : "+50 Mastery")]]);
  globalThis.fetch = fx;
  const { itemStats } = await import("../docs/gear.js");
  const crit = await itemStats(5000, [1]);
  const mast = await itemStats(5000, [2]);
  assert.equal(crit.crit, 50);
  assert.equal(mast.mastery, 50);
  assert.equal(fx.calls.length, 2, "distinct bonus IDs must not collide in cache");
});

// A confounded field-delta (better players itemize better -> a 27% "mastery" or 12% "gem"
// delta on a small/skewed field) must not inflate a gear lever past the "gear is a few %"
// ceiling. Especially for an ABOVE-FIELD player, whose levers reconcile vs the gap-to-top
// with no field gap to bound them. GEAR_LEVER_CAP caps both the bundled stat lever + gems.
test("GEAR_LEVER_CAP: a confounded gem delta can't push the gem lever past the few-% ceiling", async () => {
  const { gemLever, GEAR_LEVER_CAP } = await import("../docs/gear.js");
  assert.equal(GEAR_LEVER_CAP, 10);
  const gf = { gems: {
    fieldTop: [[111, 5]], fieldTopName: "Flawless Quick Amethyst",
    yourGems: new Map([[222, 3]]), fieldVarietyMed: 2, yourVariety: 3,
  } };
  // A wildly confounded 27% gem delta -> the lever must size at the cap, not 27%.
  const hi = gemLever(gf, { pct: 27, nHave: 5, nNot: 4 });
  assert.equal(hi.length, 1);
  assert.equal(hi[0].impact, GEAR_LEVER_CAP, "27% gem delta capped to 10");
  // A normal small delta passes through untouched.
  const lo = gemLever(gf, { pct: 3, nHave: 5, nNot: 5 });
  assert.equal(lo[0].impact, 3, "a real 3% gem delta is unchanged");
});

// When OUTPUT already beats the field (you're ahead, not behind), the confounded field-delta
// levers get a tighter ceiling -- a player out-performing the field has little real gear to
// add. Found reviewing Chiqasaurus (Pres Evoker 30% ahead, still ~20% gear post-cap).
test("GEAR_LEVER_CAP_AHEAD: an above-field player's gem lever is capped tighter", async () => {
  const { gemLever, GEAR_LEVER_CAP, GEAR_LEVER_CAP_AHEAD } = await import("../docs/gear.js");
  assert.equal(GEAR_LEVER_CAP_AHEAD, 4);
  assert.ok(GEAR_LEVER_CAP_AHEAD < GEAR_LEVER_CAP, "ahead cap is tighter than the normal cap");
  const gf = { gems: {
    fieldTop: [[111, 5]], fieldTopName: "Flawless Quick Amethyst",
    yourGems: new Map([[222, 3]]), fieldVarietyMed: 2, yourVariety: 3,
  } };
  const delta = { pct: 12, nHave: 5, nNot: 4 };
  assert.equal(gemLever(gf, delta)[0].impact, GEAR_LEVER_CAP, "behind/normal: capped at 10");
  assert.equal(gemLever(gf, delta, GEAR_LEVER_CAP_AHEAD)[0].impact, GEAR_LEVER_CAP_AHEAD, "ahead: capped at 4");
});
