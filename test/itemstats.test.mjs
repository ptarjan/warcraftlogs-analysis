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
  // rating. A +260 crit swap is worth ~0.52% -> rounds to ~1%, basis measured.
  const sv = { pct: 6, perRating: 6 / 3000, nHave: 6, nNot: 5 };
  const s = statValueScore(260, sv);
  assert.equal(s.label, "~1% DPS");
  assert.ok(Math.abs(s.impact - 0.52) < 0.01);
});

test("statValueScore: caps a single swap at the whole stat-spread value (and 5%)", async () => {
  const { statValueScore } = await import("../docs/gear.js");
  // A huge gain can't claim more than the field's measured spread value (4%).
  const s = statValueScore(99999, { pct: 4, perRating: 1, nHave: 6, nNot: 6 });
  assert.equal(s.impact, 4);
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

// A swap candidate from an OLD expansion (low base ilvl, but bonus-scaled to look current)
// is a net downgrade despite more of the priority stat -- the finder must skip it. The base
// (empty-bonus) ilvl is the tell: current pieces cluster ~250-300, the misfired DF drop was 53.
test("withinSwapIlvl: rejects a cross-expansion drop, keeps current-tier sidegrades", async () => {
  const { withinSwapIlvl, SWAP_ILVL_FLOOR } = await import("../docs/gear.js");
  assert.equal(SWAP_ILVL_FLOOR, 100);
  assert.equal(withinSwapIlvl(53, 289), false, "a Dragonflight base-53 drop vs your ilvl-289 slot is out");
  assert.equal(withinSwapIlvl(246, 289), true, "a current base-246 piece (scales up) stays in");
  assert.equal(withinSwapIlvl(289, 289), true, "same base ilvl is in");
  assert.equal(withinSwapIlvl(null, 289), true, "unknown candidate ilvl fails open (keep)");
  assert.equal(withinSwapIlvl(53, null), true, "unknown your ilvl fails open (keep)");
});
