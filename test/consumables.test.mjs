import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";
installLocalStorage();
const { detectMine, tallyField } = await import("../docs/consumables.js");

test("detectMine: classifies your auras into flask/food/potion/oil/augrune", () => {
  const auras = {
    "Flask of Alchemical Chaos": { pct: 95, guid: 1 },
    "Well Fed": { pct: 100, guid: 2 },
    "Tempered Potion": { pct: 3, guid: 3 },        // a combat potion (brief uptime, minPct 0)
    "Healing Potion": { pct: 5, guid: 9 },          // excluded: healing potion
  };
  const m = detectMine(auras);
  assert.equal(m.flask.name, "Flask of Alchemical Chaos");
  assert.equal(m.food.name, "Well Fed");
  assert.equal(m.potion.name, "Tempered Potion");
  assert.equal(m.oil, null, "no weapon oil aura -> null");
  assert.equal(m.augrune, null);
});

test("tallyField: counts the field's pick per category, one per peer", () => {
  const peers = [
    { "Flask of Alchemical Chaos": { pct: 90, guid: 1 }, "Well Fed": { pct: 100, guid: 2 } },
    { "Flask of Alchemical Chaos": { pct: 90, guid: 1 } },
    { "Flask of Tempered Aggression": { pct: 90, guid: 7 }, "Well Fed": { pct: 100, guid: 2 } },
  ];
  const { tally, guids } = tallyField(peers);
  assert.equal(tally.flask.get("Flask of Alchemical Chaos"), 2);
  assert.equal(tally.flask.get("Flask of Tempered Aggression"), 1);
  assert.equal(tally.food.get("Well Fed"), 2);
  assert.equal(guids["Flask of Alchemical Chaos"], 1);
  assert.equal(tally.oil.size, 0, "nobody ran oil");
});
