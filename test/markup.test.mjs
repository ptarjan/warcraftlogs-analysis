// The pure markup tokenizer behind app.js's fillText: [label](url) links + **bold**.
import test from "node:test";
import assert from "node:assert/strict";
const { tokenizeMarkup } = await import("../docs/markup.js");

test("tokenizeMarkup: plain text is one text token", () => {
  assert.deepEqual(tokenizeMarkup("just words"), [{ type: "text", text: "just words" }]);
});

test("tokenizeMarkup: a link becomes a link token with label + href, text around it preserved", () => {
  const t = tokenizeMarkup("swap to [Sash](https://wowhead.com/item=1) now");
  assert.deepEqual(t, [
    { type: "text", text: "swap to " },
    { type: "link", text: "Sash", href: "https://wowhead.com/item=1" },
    { type: "text", text: " now" },
  ]);
});

test("tokenizeMarkup: **bold** becomes a bold token (progression headlines)", () => {
  const t = tokenizeMarkup("**Avoid Decimate** — it kills someone");
  assert.deepEqual(t, [
    { type: "bold", text: "Avoid Decimate" },
    { type: "text", text: " — it kills someone" },
  ]);
});

test("tokenizeMarkup: links and bold mixed, in order", () => {
  const t = tokenizeMarkup("**Raid** is short — bring [a Priest](https://wowhead.com/spell=10060)");
  assert.deepEqual(t.map((x) => x.type), ["bold", "text", "link"]);
  assert.equal(t[2].href, "https://wowhead.com/spell=10060");
});

test("tokenizeMarkup: only http(s) links match; a bare [x](y) stays text", () => {
  assert.deepEqual(tokenizeMarkup("see [docs](ftp://x)"), [{ type: "text", text: "see [docs](ftp://x)" }]);
});

test("tokenizeMarkup: null/empty -> no tokens", () => {
  assert.deepEqual(tokenizeMarkup(""), []);
  assert.deepEqual(tokenizeMarkup(null), []);
  assert.deepEqual(tokenizeMarkup(undefined), []);
});
