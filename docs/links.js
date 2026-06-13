// @ts-check
// Wowhead deep links as [label](url) markdown -- the renderer's linkify() turns
// these into safe anchors. WoW item/spell ids from WCL are real Wowhead ids, so
// these resolve correctly (and Wowhead's hover tooltip kicks in on the page).
const esc = (s) => String(s).replace(/[\[\]()]/g, ""); // keep markdown unambiguous

export const wowheadItem = (id, name) =>
  id ? `[${esc(name)}](https://www.wowhead.com/item=${id})` : esc(name);

export const wowheadSpell = (id, name) =>
  id ? `[${esc(name)}](https://www.wowhead.com/spell=${id})` : esc(name);
