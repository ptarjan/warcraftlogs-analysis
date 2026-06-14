// Healer-specific levers (docs/healing.js): the OVERHEALING + MANA efficiency
// levers, and the role gate. Pure unit tests -- no network, no mock fetch.
import test from "node:test";
import assert from "node:assert/strict";

const { setRunMetric, runMetric } = await import("../docs/core.js");
const { worstSpill, overhealLever, manaLever, healingLevers } = await import("../docs/healing.js");

// Run a body with the metric forced, always restoring "dps" (never leak the
// module-level metric into another test).
const asHealer = (fn) => { try { setRunMetric("hps"); return fn(); } finally { setRunMetric("dps"); } };

test("worstSpill: names the biggest absolute spillers, ignores tiny full-overheal procs", () => {
  const you = {
    overhealBy: { "Big Heal": 5e7, "Tank Heal": 3e7, "Tiny Proc": 1e5, "Efficient": 1e6 },
    dmgBy:      { "Big Heal": 6e7, "Tank Heal": 4e7, "Tiny Proc": 0,   "Efficient": 9e7 },
  };
  const w = worstSpill(you);
  assert.deepEqual(w, ["Big Heal", "Tank Heal"]);   // biggest spill first; tiny proc below the share floor
  assert.ok(!w.includes("Tiny Proc"), "a tiny 100%-overheal proc isn't your biggest problem");
});

test("overhealLever: fires when you spill more than the field, sized + named, measured", () => {
  asHealer(() => {
    const you = { overhealPct: 45, overhealBy: { "Big Heal": 5e7, "Tank Heal": 3e7 }, dmgBy: { "Big Heal": 6e7, "Tank Heal": 4e7 } };
    const [lev] = overhealLever(you, { overhealMed: 25 });
    assert.ok(lev, "fires when 45% vs field 25%");
    assert.match(lev.text, /OVERHEALING/);
    assert.match(lev.text, /Big Heal/);              // names your worst spill (field-derived, no hard-coded spell)
    assert.equal(lev.basis, "measured");
    assert.ok(lev.impact >= 1 && lev.impact <= 10, "sized within the 1..10 cap");
    assert.match(lev.label, /% HPS/);                // healer unit
  });
});

test("overhealLever: silent within noise, when cleaner than the field, or with no field", () => {
  asHealer(() => {
    const base = { overhealBy: { "Big Heal": 1e7 }, dmgBy: { "Big Heal": 9e7 } };
    assert.equal(overhealLever({ ...base, overhealPct: 27 }, { overhealMed: 25 }).length, 0, "within 5pp = noise");
    assert.equal(overhealLever({ ...base, overhealPct: 20 }, { overhealMed: 35 }).length, 0, "cleaner than field -> never punish");
    assert.equal(overhealLever({ ...base, overhealPct: 60 }, { overhealMed: null }).length, 0, "no field baseline -> no claim");
  });
});

test("manaLever: OOM and big leftover mana both fire as measured diagnostics; mid-range silent", () => {
  asHealer(() => {
    const oom = manaLever({ mana: { oom: 180000, endPct: 8, minPct: 2 } });
    assert.match(oom[0].text, /MANA/);
    assert.match(oom[0].text, /empty|dry|regen/i);
    const left = manaLever({ mana: { oom: null, endPct: 40, minPct: 35 } });
    assert.match(left[0].text, /headroom|unspent/i);
    assert.equal(manaLever({ mana: { oom: null, endPct: 10, minPct: 8 } }).length, 0, "spent most of it -> no lever");
    const recovered = manaLever({ mana: { oom: 30000, endPct: 55, minPct: 4 } });   // dipped to 4% but ended 55%
    assert.match(recovered[0].text, /headroom|unspent/i, "ended high -> headroom lever, NOT a 'ran dry' callout");
    assert.equal(manaLever({}).length, 0, "no mana data -> silent");
  });
});

test("healingLevers is gated: silent on a DPS run even with overheal present", () => {
  const you = { overhealPct: 60, overhealBy: { X: 5e7 }, dmgBy: { X: 5e7 }, mana: { oom: null, endPct: 50 } };
  assert.equal(runMetric(), "dps");
  assert.equal(healingLevers(you, { overhealMed: 20 }).length, 0, "DPS run -> no healer levers");
  asHealer(() => {
    assert.ok(healingLevers(you, { overhealMed: 20 }).length >= 1, "healer run -> levers fire");
  });
});
