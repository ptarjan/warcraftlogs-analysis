// The Wowhead tooltip parsing in gear.js (secondary stats, embellished, unique,
// item level) is the most regression-prone code -- it broke repeatedly during
// development. These lock in its behavior against canned tooltips.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage, mockFetch, tooltip } from "./helpers.mjs";

installLocalStorage();

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
