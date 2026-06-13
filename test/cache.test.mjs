// The persistent (localStorage) query cache: a successful result must round-trip
// so a refresh re-uses it instead of re-spending quota, a miss must be clean, and
// an oversized response must NOT be persisted (it would blow localStorage's small
// budget -- the in-memory cache still covers it for the session).
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();

test("persistent query cache round-trips, misses cleanly, skips oversized", async () => {
  const { _cacheRead, _cacheWrite } = await import("../docs/wcl.js");

  _cacheWrite("query{ a }", { hello: "world" });
  assert.deepEqual(_cacheRead("query{ a }"), { hello: "world" }, "stored result is returned");

  assert.equal(_cacheRead("query{ never-written }"), undefined, "a miss returns undefined");

  // Responses bigger than the per-entry cap are not persisted.
  _cacheWrite("query{ big }", { blob: "z".repeat(500 * 1024) });
  assert.equal(_cacheRead("query{ big }"), undefined, "oversized response is not persisted");
});
