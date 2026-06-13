// Shareable/deep-linkable result URLs: ?char=NAME&region=US&server=slug[&run=1].
// Pure string helpers so a result is bookmarkable and the address bar can stay
// in sync -- reinforcing the "just a name / one link" edge. Unit-tested offline.

// Read character params out of a URL query string (leading "?" optional).
export function paramsFromSearch(search) {
  const p = new URLSearchParams(search || "");
  const get = (k) => (p.get(k) || "").trim();
  return {
    name: get("char") || get("name"),
    region: (get("region") || "").toUpperCase(),
    server: get("server"), // realm slug
    run: p.get("run") === "1" || (p.has("run") && p.get("run") !== "0"),
  };
}

// Build the shareable query string (no leading "?") for a given character.
export function shareSearch({ name, region, server } = {}) {
  const p = new URLSearchParams();
  if (name) p.set("char", name);
  if (region) p.set("region", region);
  if (server) p.set("server", server);
  const s = p.toString();
  return s ? "?" + s : "";
}
