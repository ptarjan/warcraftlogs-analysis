import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";
installLocalStorage();
const { talentDiff, buildTalentIndex, talentLabel, looksLikeDpsTalent } = await import("../docs/talents.js");

// Cases drawn from the real corpus (all 39 specs' tooltips), incl. the ones a
// 2-spec heuristic got wrong.
test("looksLikeDpsTalent drops pure utility/defensive the field still unanimously takes", () => {
  assert.equal(looksLikeDpsTalent("Removes all Poison and Disease effects from the target."), false); // Detox
  assert.equal(looksLikeDpsTalent("Blasts targets within 15 yards, knocking them back and reducing movement speed."), false); // Typhoon
  assert.equal(looksLikeDpsTalent("Increases the range of Leg Sweep."), false);          // Tiger Tail Sweep
  assert.equal(looksLikeDpsTalent("Reduces all damage taken by 50% for 6 sec."), false); // Survival Instincts (defensive "damage")
  assert.equal(looksLikeDpsTalent("Instantly heals you for 30% of your maximum health."), false);
  assert.equal(looksLikeDpsTalent(""), false);
});

test("looksLikeDpsTalent keeps damage talents, even hybrids that ALSO heal/shield", () => {
  assert.equal(looksLikeDpsTalent("Exploding Keg... each dealing (200% of Attack Power) Physical damage."), true); // Empty the Cellar
  assert.equal(looksLikeDpsTalent("Blackout Kick and Tiger Palm deal 15% additional damage in a line."), true);    // Overwhelming Force
  assert.equal(looksLikeDpsTalent("Living Flame deals 10% increased damage and healing."), true);  // Engulfing Blaze (hybrid)
  assert.equal(looksLikeDpsTalent("Thrash and Maul grant you an absorb shield, and deal 20% increased damage."), true); // hybrid w/ absorb
  assert.equal(looksLikeDpsTalent("Increases your Haste by 15%."), true);                 // a throughput stat
});

test("buildTalentIndex maps Raidbots node/entry ids to names + spell ids", () => {
  // shape mirrors Raidbots talents.json: WCL nodeID === node.id, WCL id === entry.id
  const spec = {
    classNodes: [{ id: 100, name: "Rake", entries: [{ id: 5001, name: "Rake", spellId: 1822 }] }],
    specNodes: [{ id: 200, name: "Maul", entries: [{ id: 5002, name: "Maul", spellId: 6807 }] }],
  };
  const idx = buildTalentIndex(spec);
  assert.equal(idx.byNode.get(100), "Rake");
  assert.deepEqual(idx.byEntry.get(5002), { name: "Maul", spellId: 6807 });
  // talentLabel resolves a taken node (nodeID, entryId) -> name + link target
  assert.deepEqual(talentLabel(idx, 200, 5002), { name: "Maul", spellId: 6807 });
});

test("talentLabel falls back to the entry name, then a placeholder", () => {
  const idx = buildTalentIndex({ classNodes: [{ id: 1, entries: [{ id: 9, name: "Gore", spellId: 210706 }] }] });
  assert.equal(talentLabel(idx, 1, 9).name, "Gore");        // node had no name -> entry name
  assert.equal(talentLabel(idx, 99, 99).name, "talent 99"); // unknown -> placeholder, no crash
  assert.equal(talentLabel(idx, 99, 99).spellId, null);
});

test("talentDiff flags missing meta talents and off-meta picks", () => {
  const you = new Map([
    [1, { id: 111, rank: 1 }], // meta, you have it
    [2, { id: 222, rank: 1 }], // meta, you have it
    [9, { id: 999, rank: 1 }], // you have it; field rarely does -> off-meta
  ]);
  const field = new Map([
    [1, { count: 9, id: 111 }], // 90% -> meta
    [2, { count: 7, id: 222 }], // 70% -> meta
    [3, { count: 8, id: 333 }], // 80% -> meta, you DON'T have -> missing
    [9, { count: 1, id: 999 }], // 10% -> off-meta
  ]);
  const d = talentDiff(you, field, 10);
  assert.equal(d.metaTotal, 3);                 // nodes 1,2,3
  assert.equal(d.matched, 2);                   // nodes 1,2
  assert.deepEqual(d.missing.map((m) => m.node), [3]);
  assert.equal(d.missing[0].id, 333);
  assert.deepEqual(d.offMeta.map((m) => m.node), [9]);
});

test("talentDiff: a build matching the field has no missing/off-meta", () => {
  const you = new Map([[1, { id: 111, rank: 1 }], [2, { id: 222, rank: 1 }]]);
  const field = new Map([[1, { count: 10, id: 111 }], [2, { count: 8, id: 222 }]]);
  const d = talentDiff(you, field, 10);
  assert.equal(d.matched, d.metaTotal);
  assert.equal(d.missing.length, 0);
  assert.equal(d.offMeta.length, 0);
});
