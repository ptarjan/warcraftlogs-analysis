// Pure, class-agnostic top-parse helpers: buff-gap diff, damage-routing split,
// potion count, comp-impact estimate. No ability names, no class assumptions,
// no network.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { buffGaps, nonBossShare, potionCount, compImpactPct } = await import("../docs/topparse.js");

const buff = (pct, guid = 1) => ({ pct, guid });

test("buffGaps surfaces an external buff the top parses keep up and you lack", () => {
  const you = { "Ancient Hysteria": buff(0) };           // you never got Ebon Might
  const top = [
    { "Ebon Might": buff(90), "Bloodlust": buff(15) },
    { "Ebon Might": buff(85), "Bloodlust": buff(15) },
    { "Ebon Might": buff(95), "Bloodlust": buff(15) },
  ];
  const gaps = buffGaps(you, top);
  const eb = gaps.find((g) => g.name === "Ebon Might");
  assert.ok(eb, "Ebon Might gap is surfaced");
  assert.equal(eb.comp, true);                            // you had ~0 -> a comp gap
  assert.equal(eb.top, 90);                               // median of the top parses
  // Bloodlust at 15% median is below minTop -> not flagged as a gap.
  assert.ok(!gaps.some((g) => g.name === "Bloodlust"));
});

test("buffGaps marks a buff you under-RUN (not zero) as execution, not comp", () => {
  const you = { "Power Infusion": buff(20) };
  const top = [{ "Power Infusion": buff(70) }, { "Power Infusion": buff(60) }, { "Power Infusion": buff(65) }];
  const gaps = buffGaps(you, top);
  assert.equal(gaps[0].name, "Power Infusion");
  assert.equal(gaps[0].comp, false);                      // you had some -> not a pure comp gap
});

test("buffGaps: a self-applicable buff (food/flask) you lack is NOT comp", () => {
  const you = { "Bloodlust": buff(0) };                  // you ate no food
  const top = [{ "Well Fed": buff(100) }, { "Well Fed": buff(100) }, { "Well Fed": buff(95) }];
  const g = buffGaps(you, top).find((x) => x.name === "Well Fed");
  assert.ok(g, "the Well Fed gap is surfaced");
  assert.equal(g.comp, false, "food is self-applicable -> a setup fix, never comp");
});

test("buffGaps ignores buffs you already match", () => {
  const you = { "Mark of the Wild": buff(100) };
  const top = [{ "Mark of the Wild": buff(100) }, { "Mark of the Wild": buff(100) }];
  assert.deepEqual(buffGaps(you, top), []);
});

test("nonBossShare splits boss vs adds and aggregates the adds", () => {
  const targets = [
    { name: "Boss", total: 700 },
    { name: "Add A", total: 200 },
    { name: "Add B", total: 100 },
  ];
  const r = nonBossShare(targets, "Boss");
  assert.equal(r.pct, 30);                                // 300 of 1000 on non-boss
  assert.equal(r.byAdd.get("Add A"), 200);
  assert.equal(r.byAdd.get("Add B"), 100);
});

test("nonBossShare is 0 when everything hits the boss", () => {
  const r = nonBossShare([{ name: "Boss", total: 500 }], "Boss");
  assert.equal(r.pct, 0);
});

test("potionCount keyword-matches potion casts (case-insensitive)", () => {
  assert.equal(potionCount({ "Tempered Potion": 2, "Tiger Palm": 50, "potion of unwavering focus": 1 }), 3);
  assert.equal(potionCount({}), 0);
});

test("compImpactPct scales with uptime and stays clamped", () => {
  assert.equal(compImpactPct(0), 4);                      // floor
  assert.equal(compImpactPct(100), 12);                   // 100% * 0.12 = 12
  assert.equal(compImpactPct(1000), 14);                  // clamped at the ceiling
});
