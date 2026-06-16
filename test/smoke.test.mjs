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

test("overview.isUnrepresentativeKill: flags the CONTRADICTION (decent %ile + tiny output), not just a low kill", async () => {
  const { isUnrepresentativeKill } = await import("../docs/overview.js");
  // The real bug (Burlis): a 5,045-dps / 38%-active Crown kill WCL still scored 52%ile,
  // and an 18k-dps 90%-active Imperator scored 94%ile -- contradictions vs 190k/162k peers.
  assert.equal(isUnrepresentativeKill({ dps: 5045, activePct: 38 }, 96, 190738, 52), true, "death but 52%ile");
  assert.equal(isUnrepresentativeKill({ dps: 18013, activePct: 90 }, 99, 162513, 94), true, "<30% of peers but 94%ile");
  // FALSE-POSITIVE GUARD (Lisalisa): low output + LOW %ile is a consistent bad kill, SHOW it.
  assert.equal(isUnrepresentativeKill({ dps: 58480, activePct: 66 }, 100, 200000, 6), false, "66% active but only 6%ile -> real bad kill");
  assert.equal(isUnrepresentativeKill({ dps: 50274, activePct: 99 }, 100, 167000, 11), false, "damage-bound healer, 11%ile -> shown");
  // A genuinely-behind-but-real kill (~46% of peers, 99% active, mid %ile) is NOT flagged.
  assert.equal(isUnrepresentativeKill({ dps: 53000, activePct: 99 }, 99, 114700, 45), false, "real bad kill still shown");
  // A normal/good kill is not flagged.
  assert.equal(isUnrepresentativeKill({ dps: 120000, activePct: 99 }, 99, 130000, 80), false);
  // Defensive: no %ile / no peers -> can't judge -> not flagged.
  assert.equal(isUnrepresentativeKill({ dps: 5045, activePct: 38 }, 96, 190738, null), false);
  assert.equal(isUnrepresentativeKill(null, 99, 100000, 90), false);
});
