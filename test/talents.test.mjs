import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";
installLocalStorage();
const { talentDiff, buildTalentIndex, talentLabel, looksLikeDpsTalent } = await import("../docs/talents.js");

test("looksLikeDpsTalent keeps damage talents and drops utility/defensive ones", () => {
  // real tooltip fragments: utility the field takes unanimously must NOT count.
  assert.equal(looksLikeDpsTalent("Detox. Removes all Poison and Disease effects."), false);
  assert.equal(looksLikeDpsTalent("Typhoon. Blasts targets, knocking them back."), false);
  assert.equal(looksLikeDpsTalent("Increases the range of Leg Sweep."), false);
  assert.equal(looksLikeDpsTalent("Survival Instincts. Reduces all damage taken by 50%."), false); // has "damage" but defensive
  // genuine throughput
  assert.equal(looksLikeDpsTalent("Exploding Keg deals 12000 Fire damage."), true);
  assert.equal(looksLikeDpsTalent("Increases your Critical Strike by 3%."), true);
  assert.equal(looksLikeDpsTalent(""), false);
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
