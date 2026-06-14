// Pure, class-agnostic top-parse helpers: raid-comp coverage (curated damage
// amps), damage-routing split, potion count. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { raidCoverage, nonBossShare, potionCount, RAID_DAMAGE, topParseLevers } = await import("../docs/topparse.js");
const { setRunMetric } = await import("../docs/core.js");

const aura = (pct, guid = 1) => ({ pct, guid });

test("raidCoverage finds present amps (self buffs + boss debuff) and the missing ones", () => {
  const selfBuffs = { "Arcane Intellect": aura(100), "Bloodlust": aura(15) };
  const boss = { "Chaos Brand": aura(95) };               // a debuff ON the boss
  const { present, missing } = raidCoverage(selfBuffs, boss);
  const pk = present.map((e) => e.key), mk = missing.map((e) => e.key);
  assert.ok(pk.includes("ai") && pk.includes("lust") && pk.includes("chaosbrand"));
  assert.ok(mk.includes("mystictouch"));                  // a Monk debuff we lack
  assert.ok(mk.includes("pi"));                           // no Power Infusion
  // nothing is both present and missing
  assert.equal(pk.filter((k) => mk.includes(k)).length, 0);
});

test("raidCoverage SKIPS boss-side amps when the boss debuffs can't be read", () => {
  const { present, missing } = raidCoverage({ "Battle Shout": aura(100) }, null);
  const boss = (e) => e.on === "boss";
  // Chaos Brand / Mystic Touch are neither claimed present nor flagged missing.
  assert.ok(!present.some(boss) && !missing.some(boss));
  assert.ok(present.some((e) => e.key === "battleshout"));
});

test("raidCoverage ignores a trace-uptime aura (a brief mis-application isn't 'present')", () => {
  const { missing } = raidCoverage({ "Arcane Intellect": aura(0.5) }, null);
  assert.ok(missing.some((e) => e.key === "ai"));         // 0.5% uptime -> still missing
});

test("Chaos Brand is modelled as a BOSS debuff from a Demon Hunter", () => {
  const cb = RAID_DAMAGE.find((e) => e.key === "chaosbrand");
  assert.equal(cb.on, "boss");
  assert.match(cb.who, /Demon Hunter/);
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
});

test("nonBossShare is 0 when everything hits the boss", () => {
  assert.equal(nonBossShare([{ name: "Boss", total: 500 }], "Boss").pct, 0);
});

test("nonBossShare falls back to the biggest target when the name doesn't match", () => {
  // Encounter "Crown of the Cosmos" but the boss NPC is named differently -- no
  // exact match must NOT report 100% non-boss; the biggest target is the boss.
  const targets = [{ name: "Salhadaar", total: 700 }, { name: "Add", total: 300 }];
  assert.equal(nonBossShare(targets, "Crown of the Cosmos").pct, 30);
});

test("potionCount keyword-matches potion casts (case-insensitive)", () => {
  assert.equal(potionCount({ "Tempered Potion": 2, "Tiger Palm": 50, "potion of unwavering focus": 1 }), 3);
  assert.equal(potionCount({}), 0);
});

test("topParseLevers: comp magnitude is MEASURED from the field, never a curated estimate", () => {
  const missing = [RAID_DAMAGE.find((e) => e.key === "pi"), RAID_DAMAGE.find((e) => e.key === "aug")];
  const tp = { comp: { missing }, routing: null, potions: null };
  // With a measured field delta -> sized from it (not a hardcoded est), basis measured.
  const sized = topParseLevers(tp, { pi: { pct: 11, nHave: 5, nNot: 6 } });
  const piLev = sized.find((r) => /Power Infusion/.test(r.text));
  assert.equal(piLev.impact, 11, "magnitude comes from the field delta");
  assert.equal(piLev.basis, "measured");
  assert.match(piLev.text, /measured: peers with it do 11% more/);
  // No split to measure (aug) -> UNSIZED (INFO, 0 impact), NOT a fabricated %.
  const augLev = sized.find((r) => /Augmentation/.test(r.text));
  assert.equal(augLev.impact, 0, "unmeasurable comp claims 0 of the gap, not a guess");
  assert.equal(augLev.label, "info");
  assert.match(augLev.text, /unmeasured|no with\/without split/i);
});

test("topParseLevers: damage-ROUTING lever is suppressed for healers (HPS run)", () => {
  // A damage-target-distribution lever told a Mistweaver to "cleave/funnel instead
  // of tunneling the boss" to raise HPS -- nonsense for a healer. It must fire for
  // DPS and stay silent for healers, independent of the broader healer design.
  const tp = { comp: { missing: [] }, routing: { top: 75, you: 60, addNames: ["Add A", "Add B"] } };
  try {
    setRunMetric("dps");
    const dps = topParseLevers(tp);
    assert.ok(dps.some((r) => /^ROUTING/.test(r.text)), "ROUTING should fire for DPS");
    setRunMetric("hps");
    const hps = topParseLevers(tp);
    assert.ok(!hps.some((r) => /^ROUTING/.test(r.text)), "ROUTING must NOT fire for a healer");
  } finally {
    setRunMetric("dps");                            // never leak the global to other tests
  }
});
