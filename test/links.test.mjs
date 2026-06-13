import test from "node:test";
import assert from "node:assert/strict";
import { wowheadItem, wowheadSpell } from "../docs/links.js";

test("wowheadItem builds a markdown link to the item page", () => {
  assert.equal(wowheadItem(212398, "Bludgeons of Blistering Wind"),
    "[Bludgeons of Blistering Wind](https://www.wowhead.com/item=212398)");
});

test("wowheadSpell builds a markdown link to the spell page", () => {
  assert.equal(wowheadSpell(121253, "Keg Smash"),
    "[Keg Smash](https://www.wowhead.com/spell=121253)");
});

test("no id -> plain (escaped) name, no link", () => {
  assert.equal(wowheadItem(0, "Mystery Item"), "Mystery Item");
  assert.equal(wowheadItem(null, "X"), "X");
});

test("brackets/parens in a name can't break the markdown", () => {
  assert.equal(wowheadItem(5, "Gaze (of) [the] Alnseer"),
    "[Gaze of the Alnseer](https://www.wowhead.com/item=5)");
});
