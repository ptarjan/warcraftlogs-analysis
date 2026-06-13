import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";
installLocalStorage();
const { profileDiff } = await import("../docs/profile.js");

test("profileDiff finds where your damage share diverges from the field", () => {
  // You lean on a filler; the field gets a big chunk from an ability you barely use.
  const you = { Filler: 600, KegSmash: 300, Special: 100 };       // 60 / 30 / 10
  const field = [
    { Filler: 300, KegSmash: 300, Special: 400 },                 // 30 / 30 / 40
    { Filler: 320, KegSmash: 280, Special: 400 },                 // 32 / 28 / 40
  ];
  const rows = profileDiff(you, field);
  // Biggest gap is Special (you 10% vs field ~40% -> under-using).
  assert.equal(rows[0].ability, "Special");
  assert.ok(rows[0].delta < 0, "Special should be a deficit (you below field)");
  const filler = rows.find((r) => r.ability === "Filler");
  assert.ok(filler.delta > 0, "Filler should be an excess (you above field)");
});

test("profileDiff handles an ability the field uses but you don't (0%)", () => {
  const rows = profileDiff({ A: 100 }, [{ A: 50, B: 50 }]);
  const b = rows.find((r) => r.ability === "B");
  assert.equal(b.you, 0);
  assert.ok(b.field > 0);
});

test("identical profiles -> ~zero deltas", () => {
  const rows = profileDiff({ A: 50, B: 50 }, [{ A: 50, B: 50 }]);
  assert.ok(rows.every((r) => Math.abs(r.delta) < 1e-9));
});
