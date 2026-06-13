import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../docs/core.js";

test("mapLimit preserves input order and caps concurrency", async () => {
  let active = 0, maxActive = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapLimit(items, 5, async (x) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return x * 2;
  });
  assert.deepEqual(out, items.map((x) => x * 2));
  assert.ok(maxActive <= 5, `concurrency exceeded cap: ${maxActive}`);
  assert.ok(maxActive >= 2, "expected some parallelism");
});

test("mapLimit turns a worker error into null without failing the batch", async () => {
  const out = await mapLimit([1, 2, 3], 2, async (x) => {
    if (x === 2) throw new Error("boom");
    return x;
  });
  assert.deepEqual(out, [1, null, 3]);
});

test("mapLimit handles empty input", async () => {
  assert.deepEqual(await mapLimit([], 5, async () => 1), []);
});
