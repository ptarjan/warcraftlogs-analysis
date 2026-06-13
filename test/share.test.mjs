import test from "node:test";
import assert from "node:assert/strict";
import { paramsFromSearch, shareSearch } from "../docs/share.js";

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
