// Guard: real network must be blocked by default in tests (no live site / WCL
// rate limits). If this fails, the setup.mjs preload isn't being applied.
import test from "node:test";
import assert from "node:assert/strict";

test("fetch is blocked by default in the test runner", async () => {
  await assert.rejects(
    () => fetch("https://www.warcraftlogs.com/api/v2/client"),
    /Blocked a real network fetch in tests/,
  );
});
