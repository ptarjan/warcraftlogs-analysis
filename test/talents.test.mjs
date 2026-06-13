import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";
installLocalStorage();
const { talentDiff } = await import("../docs/talents.js");

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
