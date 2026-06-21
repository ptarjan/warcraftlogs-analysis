// Pure, class-agnostic top-parse helpers: raid-comp coverage (curated damage
// amps), damage-routing split, potion count. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { raidCoverage, nonBossShare, potionCount, RAID_DAMAGE, topParseLevers, funnelCleaveShare } = await import("../docs/topparse.js");
const { setRunMetric, DIM } = await import("../docs/core.js");

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
  // ...and it must NOT claim [measured] -- its own text says it couldn't be measured.
  assert.equal(augLev.basis, "est", "unsized comp note is not measured");

  // A BOSS debuff (Chaos Brand) is sized the SAME way once measured (prescribe now
  // fetches per-peer boss debuffs on demand and merges the delta into compDeltas).
  const bossTp = { comp: { missing: [RAID_DAMAGE.find((e) => e.key === "chaosbrand")] }, routing: null, potions: null };
  const bossLev = topParseLevers(bossTp, { chaosbrand: { pct: 5, nHave: 6, nNot: 5 } })[0];
  assert.equal(bossLev.impact, 5, "boss-debuff comp sized from the measured field delta");
  assert.equal(bossLev.basis, "measured");
  // Unmeasured (near-universal field) -> still unsized, never guessed.
  assert.equal(topParseLevers(bossTp, {})[0].impact, 0);
});

test("topParseLevers: POTIONS fires only when you ran SOME (zero is owned by consumableLevers)", () => {
  const tp = (you) => ({ comp: { missing: [] }, routing: null, potions: { top: 2, you } });
  // You pre-potted but skipped the combat potion (1 of 2) -> the topparse POTIONS lever fires.
  assert.ok(topParseLevers(tp(1), {}).some((r) => /POTIONS:/.test(r.text)), "used some-but-fewer -> fires");
  // You ran ZERO -> consumableLevers' "you used none" owns it; topparse must NOT double-count.
  assert.ok(!topParseLevers(tp(0), {}).some((r) => /POTIONS:/.test(r.text)), "zero potions -> topparse defers (no double-count)");
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
    // It's YOURS to fix (target choice you control), NOT a raid-comp gap -> must land
    // in the "do these to your character" list, not the "not yours to change" comp box.
    const routing = dps.find((r) => /^ROUTING/.test(r.text));
    assert.equal(routing.dim, DIM.ROTATION, "routing is a player target-priority lever, not DIM.COMP");
    assert.notEqual(routing.dim, DIM.COMP);
    setRunMetric("hps");
    const hps = topParseLevers(tp);
    assert.ok(!hps.some((r) => /^ROUTING/.test(r.text)), "ROUTING must NOT fire for a healer");
  } finally {
    setRunMetric("dps");                            // never leak the global to other tests
  }
});

test("topParseLevers: routing is ASSIGNMENT (comp) only when you tanked a DIFFERENT target than the field", () => {
  // Data-derived (no isTank): assignment is real only when YOUR tank target differs from
  // the field's consensus. You held the boss, they held an add -> assignment (comp).
  const assigned = { comp: { missing: [] },
    routing: { top: 75, you: 60, addNames: ["Add A", "Add B"],
      tank: { name: "The Boss", share: 61 }, fieldTank: { name: "Add A", n: 2, of: 3 } } };
  const r1 = topParseLevers(assigned).find((r) => /^ROUTING/.test(r.text));
  assert.equal(r1.dim, DIM.COMP, "different tank target than the field -> assignment, comp box");
  assert.match(r1.text, /TANKING The Boss/);
  assert.match(r1.text, /assignment/i);
  // SAME tank target as the field, but they funnel MORE -> achievable on your duty -> YOURS.
  // (The Crown-of-the-Cosmos bug: both tank Alleria, field out-funnels -> NOT assignment.)
  const same = { comp: { missing: [] },
    routing: { top: 75, you: 60, addNames: ["Add A", "Add B"],
      tank: { name: "Alleria", share: 61 }, fieldTank: { name: "Alleria", n: 3, of: 3 } } };
  const r2 = topParseLevers(same).find((r) => /^ROUTING/.test(r.text));
  assert.equal(r2.dim, DIM.ROTATION, "same tank target -> a real (yours) funnel gap, not assignment");
  assert.match(r2.text, /just like you/);
  // No tank read (DPS / diffuse) -> generic funnel lever, ALONGSIDE not instead.
  const dps = { comp: { missing: [] }, routing: { top: 75, you: 60, addNames: ["Add A"], tank: null, fieldTank: null } };
  const r3 = topParseLevers(dps).find((r) => /^ROUTING/.test(r.text));
  assert.equal(r3.dim, DIM.ROTATION);
  assert.match(r3.text, /ALONGSIDE/);
  assert.doesNotMatch(r3.text, /instead of tunneling/);
});

test("funnelCleaveShare: add damage from boss-hitting abilities is cleave; add-only abilities are dedicated", () => {
  const adds = new Set(["Add A", "Add B"]);
  // Spinning Crane Kick hits the boss AND both adds -> all its add damage is cleave.
  // A dedicated nuke that only ever hit Add A -> that damage is NOT cleave.
  const abilities = [
    { name: "Spinning Crane Kick", targets: [
      { name: "Big Boss", total: 1000, type: "Boss" },
      { name: "Add A", total: 300 }, { name: "Add B", total: 200 }] },
    { name: "Summon Nuke", targets: [{ name: "Add A", total: 500 }] }, // add-only -> dedicated
  ];
  // cleave = 300+200 = 500; dedicated = 500 -> share = 0.5
  assert.equal(funnelCleaveShare(abilities, adds, "Big Boss"), 0.5);
  // All add damage from boss-hitting abilities -> share 1 (the Hadryan/Crown case).
  const allCleave = [{ name: "SCK", targets: [
    { name: "Big Boss", total: 1000, type: "Boss" }, { name: "Add A", total: 400 }] }];
  assert.equal(funnelCleaveShare(allCleave, adds, "Big Boss"), 1);
  // No add damage to classify -> null (not 0).
  assert.equal(funnelCleaveShare([{ name: "X", targets: [{ name: "Big Boss", total: 9, type: "Boss" }] }], adds, "Big Boss"), null);
});

test("funnelCleaveShare: boss identified by biggest non-add target when no Boss-type/name is present", () => {
  const adds = new Set(["Add A"]);
  // Renamed boss types as NPC; it's the biggest non-add target -> still 'main'.
  const abilities = [
    { name: "Cleave", targets: [{ name: "Council Member", total: 9000, type: "NPC" }, { name: "Add A", total: 300 }] },
    { name: "AddNuke", targets: [{ name: "Add A", total: 700 }] },
  ];
  assert.equal(funnelCleaveShare(abilities, adds, null), 0.3); // 300 cleave / 1000 total
});

test("topParseLevers: a DEDICATED-tooling funnel (low cleaveShare) is downgraded out of the yours-DPS headline", () => {
  // Same tank target as the field, but the field's add damage is mostly add-only tooling
  // (cleaveShare 0.2) -> NOT free cleave on your buttons -> comp/conditional, not DIM.ROTATION.
  const ded = { comp: { missing: [] },
    routing: { top: 75, you: 60, addNames: ["Add A", "Add B"],
      tank: { name: "Alleria", share: 61 }, fieldTank: { name: "Alleria", n: 3, of: 3 }, cleaveShare: 0.2 } };
  const r = topParseLevers(ded).find((x) => /^ROUTING/.test(x.text));
  assert.equal(r.dim, DIM.COMP, "dedicated add tooling -> not a free yours-DPS button");
  assert.match(r.text, /don't use on the boss/i);
  assert.doesNotMatch(r.text, /just like you/); // not the same-assignment yours-lever text
  // High cleaveShare on the SAME case -> stays yours (DIM.ROTATION) with a confirmation note.
  const conf = { comp: { missing: [] },
    routing: { top: 75, you: 60, addNames: ["Add A", "Add B"],
      tank: { name: "Alleria", share: 61 }, fieldTank: { name: "Alleria", n: 3, of: 3 }, cleaveShare: 1 } };
  const rc = topParseLevers(conf).find((x) => /^ROUTING/.test(x.text));
  assert.equal(rc.dim, DIM.ROTATION, "confirmed same-kit cleave stays a yours lever");
  assert.match(rc.text, /same-kit cleave you can replicate/i);
  // null cleaveShare (cache-only / no field read) -> unchanged prior behavior.
  const noRead = { comp: { missing: [] },
    routing: { top: 75, you: 60, addNames: ["Add A"],
      tank: { name: "Alleria", share: 61 }, fieldTank: { name: "Alleria", n: 3, of: 3 }, cleaveShare: null } };
  const rn = topParseLevers(noRead).find((x) => /^ROUTING/.test(x.text));
  assert.equal(rn.dim, DIM.ROTATION);
  assert.doesNotMatch(rn.text, /confirmed/i);
});
