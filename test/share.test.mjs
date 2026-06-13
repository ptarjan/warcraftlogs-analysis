import test from "node:test";
import assert from "node:assert/strict";
import { paramsFromSearch, shareSearch, encodeSnapshot, decodeSnapshot, snapshotFromHash } from "../docs/share.js";

test("paramsFromSearch reads char/region/server + run flag", () => {
  const p = paramsFromSearch("?char=Hadryan&region=us&server=proudmoore&run=1");
  assert.deepEqual(p, { name: "Hadryan", region: "US", server: "proudmoore", run: true });
});

test("paramsFromSearch: 'name' is an alias for 'char'; no run by default", () => {
  const p = paramsFromSearch("name=Foo&region=EU&server=draenor");
  assert.equal(p.name, "Foo");
  assert.equal(p.region, "EU");
  assert.equal(p.run, false);
});

test("paramsFromSearch on empty string is all-empty", () => {
  assert.deepEqual(paramsFromSearch(""), { name: "", region: "", server: "", run: false });
});

test("shareSearch round-trips with paramsFromSearch", () => {
  const s = shareSearch({ name: "Hadryan", region: "US", server: "proudmoore" });
  assert.equal(s, "?char=Hadryan&region=US&server=proudmoore");
  const back = paramsFromSearch(s);
  assert.equal(back.name, "Hadryan");
  assert.equal(back.server, "proudmoore");
});

test("shareSearch omits blank fields and returns '' when empty", () => {
  assert.equal(shareSearch({ name: "X" }), "?char=X");
  assert.equal(shareSearch({}), "");
});

test("snapshot encode -> decode round-trips a full report object", async () => {
  const snap = {
    v: 1, name: "Hadryan", serverLabel: "Proudmoore", region: "US",
    pills: [["Brewmaster Monk", false], ["Mythic", true]],
    sections: [
      { title: "What to change", primary: true, lines: ["1. [ ~5% DPS]  TALENTS: take [Empty the Cellar](https://www.wowhead.com/spell=1262329)"] },
      { title: "Talents vs the field", lines: ["=== Talents ===", "Hero tree: you run Shado-Pan"] },
    ],
  };
  const enc = await encodeSnapshot(snap);
  assert.equal(typeof enc, "string");
  assert.ok(/^[gu][A-Za-z0-9_-]+$/.test(enc), "URL-safe with a compression tag");
  assert.deepEqual(await decodeSnapshot(enc), snap);
});

test("decodeSnapshot returns null on garbage (a bad link just falls through)", async () => {
  assert.equal(await decodeSnapshot(""), null);
  assert.equal(await decodeSnapshot("g!!!notbase64!!!"), null);
  assert.equal(await decodeSnapshot("xyz"), null);
});

test("snapshotFromHash pulls the share payload out of a URL fragment", () => {
  assert.equal(snapshotFromHash("#share=gABC-_123"), "gABC-_123");
  assert.equal(snapshotFromHash("#foo=1&share=uXYZ"), "uXYZ");
  assert.equal(snapshotFromHash("#nothinghere"), "");
  assert.equal(snapshotFromHash(""), "");
});
