// "Current gear/consumables" kill selection: top item level, but the MOST RECENT
// kill at that level -- so recent enchant/gem/consumable fixes aren't hidden by an
// old high-ilvl kill. bestRank is pure (no network).
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { bestRank, isHealer, metricForSpec, setRunMetric, runMetric, metricUnit, runIsHealer, eventTable, DPS } = await import("../docs/core.js");

test("isHealer flags every healing spec, by spec name across classes", () => {
  for (const s of ["Holy", "Discipline", "Restoration", "Mistweaver", "Preservation"])
    assert.equal(isHealer(s), true, `${s} is a healer`);
  // DPS/tank specs are not healers (incl. specs that share a class with a healer)
  for (const s of ["Shadow", "Retribution", "Balance", "Frost", "Brewmaster", "Guardian", "Protection", "Devastation"])
    assert.equal(isHealer(s), false, `${s} is not a healer`);
});

test("metricForSpec: healer specs -> hps, everyone else -> dps", () => {
  for (const s of ["Holy", "Discipline", "Restoration", "Mistweaver", "Preservation"])
    assert.equal(metricForSpec("X", s), "hps", `${s} should be hps`);
  for (const s of ["Brewmaster", "Assassination", "Frost", "Protection", "Arms", "Balance"])
    assert.equal(metricForSpec("X", s), "dps", `${s} should be dps`);
});

test("setRunMetric flips the unit, event table, and the DPS() label; defaults to dps", () => {
  assert.equal(runMetric(), "dps");                 // default leaves the damage path untouched
  assert.equal(DPS(3).label, "~3% DPS");
  assert.equal(eventTable(), "DamageDone");
  try {
    setRunMetric("hps");
    assert.equal(metricUnit(), "HPS");
    assert.equal(runIsHealer(), true);
    assert.equal(eventTable(), "Healing");          // WCL healing table is "Healing", not "HealingDone"
    assert.equal(DPS(3).label, "~3% HPS");          // same impact, healing unit
    assert.equal(DPS(1, 3).label, "~1-3% HPS");
  } finally {
    setRunMetric("dps");                            // never leak the global to other tests
  }
  assert.equal(eventTable(), "DamageDone");
});

const r = (ilvl, t, id) => ({ bracketData: ilvl, startTime: t, _id: id });

test("bestRank picks the most recent kill among those at your top item level", () => {
  const picked = bestRank([r(279, 100, "old"), r(279, 500, "new"), r(279, 300, "mid")]);
  assert.equal(picked._id, "new");
});

test("bestRank prefers a recent current-ilvl kill over a stale higher one (within band)", () => {
  // The classic case: a lucky 280 drop two weeks ago vs tonight's 279 kills.
  const picked = bestRank([r(280, 100, "lucky-old"), r(279, 900, "tonight")]);
  assert.equal(picked._id, "tonight", "1 ilvl lower but far more recent -> current state");
});

test("bestRank ignores a recent kill from much lower gear (outside the band)", () => {
  const picked = bestRank([r(279, 100, "current"), r(270, 900, "alt-gear")]);
  assert.equal(picked._id, "current", "9 ilvls lower is not 'current gear', even if recent");
});

test("bestRank returns null for no ranks", () => {
  assert.equal(bestRank([]), null);
  assert.equal(bestRank(null), null);
});
