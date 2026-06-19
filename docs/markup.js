// @ts-check
// The tiny markup the analyses emit, parsed into a flat token list: [label](https://…)
// links and **bold** spans, everything else plain text. PURE (no DOM) so it's unit-tested;
// app.js's fillText turns the tokens into safe DOM nodes (anchors / <strong> / text nodes),
// never innerHTML. Keeping the parse here means the link/bold logic has a test net even
// though app.js itself (DOM glue) can't be imported under Node.
/** @typedef {{type:"text"|"link"|"bold", text:string, href?:string}} MarkupToken */

/** Parse `text` into ordered text/link/bold tokens. @param {string} text @returns {MarkupToken[]} */
export function tokenizeMarkup(text) {
  const s = String(text == null ? "" : text);
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*/g;
  /** @type {MarkupToken[]} */
  const out = [];
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ type: "text", text: s.slice(last, m.index) });
    if (m[2]) out.push({ type: "link", text: m[1], href: m[2] });
    else out.push({ type: "bold", text: m[3] });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ type: "text", text: s.slice(last) });
  return out;
}
