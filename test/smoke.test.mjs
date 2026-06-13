// Guards the dual-mode / CLI work: the browser modules must import cleanly under
// Node (no unguarded window/document/localStorage at import time) and expose the
// entry points the CLI calls.
import test from "node:test";
import assert from "node:assert/strict";
import { installLocalStorage } from "./helpers.mjs";

installLocalStorage();
globalThis.fetch = async () => { throw new Error("smoke test must not hit the network"); };

test("modules import under Node and expose their entry points", async () => {
  const config = await import("../docs/config.js");
  assert.equal(config.IS_NODE, true, "IS_NODE should be true under Node");

  const wcl = await import("../docs/wcl.js");
  assert.equal(typeof wcl.gql, "function");
  assert.equal(typeof wcl.itemTooltip, "function");
  assert.equal(typeof wcl.clearGqlCache, "function");

  // auth.js is browser-only at runtime but must import cleanly under Node
  // (no unguarded browser globals at import time -- the CLI loads wcl.js -> auth.js).
  const auth = await import("../docs/auth.js");
  assert.equal(typeof auth.beginLogin, "function");
  assert.equal(typeof auth.handleRedirectCallback, "function");
  assert.equal(typeof auth.getAccessToken, "function");

  const overview = await import("../docs/overview.js");
  assert.equal(typeof overview.run, "function");

  const timeline = await import("../docs/timeline.js");
  assert.equal(typeof timeline.run, "function");

  const gear = await import("../docs/gear.js");
  assert.equal(typeof gear.itemStats, "function");
  assert.equal(typeof gear.run, "function");

  const prescribe = await import("../docs/prescribe.js");
  assert.equal(typeof prescribe.run, "function");
});
