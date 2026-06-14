import test from "node:test";
import assert from "node:assert/strict";
import { wowheadItem, wowheadSpell, wclReport } from "../docs/links.js";

test("wclReport links a boss to its Warcraft Logs report + fight", () => {
  assert.equal(wclReport("aB12cD34", 7, "Chimaerus"),
    "[Chimaerus](https://www.warcraftlogs.com/reports/aB12cD34#fight=7)");
  assert.equal(wclReport("aB12cD34", null, "Chimaerus"),
    "[Chimaerus](https://www.warcraftlogs.com/reports/aB12cD34)");      // report only
  assert.equal(wclReport(null, 7, "Chimaerus"), "Chimaerus");          // no code -> plain
});

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
