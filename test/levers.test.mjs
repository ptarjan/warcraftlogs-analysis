// Render-path coverage for the per-module lever builders. These EXECUTE the
// finding(DIM.*, …, KIND.*) calls -- the code path that a cross-module rename
// (finding("Rotation") -> finding(DIM.ROTATION)) can break at RUNTIME while every
// unit test + the import guard stay green. The loader full-run test calls
// prescribe.run but its mock can't produce a talent finding (no Raidbots data), so
// talents.js's DIM usage went uncovered -- and a missing DIM import shipped. These
// craft synthetic findings inputs (pure functions, no fetch) so each lever kind fires.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
const { talentLevers } = await import("../docs/talents.js");
const { rotationLevers } = await import("../docs/rotation.js");
const { topParseLevers } = await import("../docs/topparse.js");

test("talentLevers: a hero mismatch + a missing meta talent fire HERO_TREE + TALENTS", () => {
  // This is the exact path that broke: talents.js building finding(DIM.ROTATION, …) for
  // a talent/hero-tree finding. A missing DIM import ReferenceErrors right here.
  const tf = {
    boss: "TestBoss",
    hero: { yours: "Colossus", field: [{ name: "Slayer", pct: 100 }] },
    missing: [{ spellId: 384110, name: "Big Hit", adopt: 0.9, dps: true, value: 5 }],
    offMeta: [],
  };
  const out = talentLevers(tf);
  assert.ok(out.length >= 2, "fires both a hero-tree and a talent lever");
  assert.ok(out.some((x) => x.kind === "HERO_TREE"), "hero-tree swap tagged KIND.HERO_TREE");
  assert.ok(out.some((x) => x.kind === "TALENTS"), "meta-talent swap tagged KIND.TALENTS");
  assert.ok(out.every((x) => x.dim === "Rotation"), "talent levers are dim Rotation");
});

test("rotationLevers: cooldown/empowerment/dot/pet/press-more all render with the right kinds", () => {
  const rot = {
    abilityIds: { A: 101, CD: 102 },
    usage: { under: [{ name: "A", you: 2, field: 7, dmgPct: 18 }], over: [] },
    cooldowns: [{ name: "CD", pct: 5, you: 0.2, field: 0.4, youCasts: 1, fieldCasts: 2 }],
    cdUsage: [],
    buffCds: [{ id: 103, name: "Buff", youPerFight: 1, fieldPerFight: 3, uplift: 0.2, pct: 4 }],
    petGap: { you: 10, field: 20, pct: 5 },
    dotGaps: [{ name: "DoT", guid: 104, you: 80, field: 99, pct: 3 }],
    perCast: [{ name: "X", youEmp: 0.1, fieldEmp: 0.3, pct: 6 }],
    talent: null, heroMatched: null,
  };
  const out = rotationLevers(rot);
  assert.ok(out.some((x) => x.kind === "COOLDOWN"), "cooldown lever tagged");
  assert.ok(out.some((x) => x.kind === "EMPOWERMENT"), "empowerment lever tagged");
  assert.ok(out.some((x) => /press .*A/.test(x.text)), "measured press-more lever fires");
  assert.ok(out.every((x) => x.dim === "Rotation"), "rotation levers are dim Rotation");
  assert.ok(out.every((x) => typeof x.impact === "number" && x.label), "every finding has impact + label");
});

test("topParseLevers: a missing self-buff comp amp renders as a dim Comp finding", () => {
  const tp = { comp: { missing: [{ key: "aug", spell: 395152, label: "Aug", effect: "throughput", who: "an Aug Evoker", on: "self" }] }, routing: null, potions: null };
  const out = topParseLevers(tp, { aug: { pct: 3, nHave: 4, nNot: 6 } });
  assert.ok(out.some((x) => x.dim === "Comp"), "comp amp is a dim Comp finding");
});
