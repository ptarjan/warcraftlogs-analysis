// @ts-check
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
/** @param {{ name?: string, region?: string, server?: string }} [c] */
export function shareSearch({ name, region, server } = {}) {
  const p = new URLSearchParams();
  if (name) p.set("char", name);
  if (region) p.set("region", region);
  if (server) p.set("server", server);
  const s = p.toString();
  return s ? "?" + s : "";
}

// --------------------------------------------------------------------------- //
// Snapshot sharing: encode a FINISHED report into the URL fragment so a friend
// can open it with NO login and NO Warcraft Logs calls. The app is connect-only
// (a full re-run is too heavy for any shared budget), so a share link carries the
// rendered result itself, not a re-run. The payload lives in the URL fragment
// (`#share=`), which the browser never sends to the server -- room for a few KB
// and nothing to store.
// --------------------------------------------------------------------------- //
const _bytesToB64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const _b64urlToBytes = (str) => {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
};
async function _gzip(bytes) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function _gunzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// Encode a snapshot object -> a compact, URL-safe string. Gzip when available
// ("g" prefix), else raw base64url ("u") so it still works without the Web
// Compression API. Reversed by decodeSnapshot.
export async function encodeSnapshot(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== "undefined") {
    try { return "g" + _bytesToB64url(await _gzip(bytes)); } catch (e) { /* fall back */ }
  }
  return "u" + _bytesToB64url(bytes);
}

// Decode an encodeSnapshot() string back into the object. Returns null on any
// malformed/garbage input (so a bad #share= link just falls through to normal).
export async function decodeSnapshot(str) {
  if (!str || str.length < 2) return null;
  try {
    let bytes = _b64urlToBytes(str.slice(1));
    if (str[0] === "g") bytes = await _gunzip(bytes);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) { return null; }
}

// Read a snapshot string out of a URL fragment ("#share=..."), or "" if none.
export function snapshotFromHash(hash) {
  const m = /[#&]share=([^&]+)/.exec(hash || "");
  return m ? decodeURIComponent(m[1]) : "";
}
