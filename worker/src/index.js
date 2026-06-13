/**
 * Cloudflare Worker: a Wowhead CORS + edge-cache proxy for the static front-end.
 *
 * The app is connect-only -- the browser talks to Warcraft Logs directly with the
 * user's OWN PKCE token (no shared secret, no shared proxy), so there is NO /wcl
 * route here anymore and this Worker holds NO secrets. It exists only because
 * Wowhead's tooltip endpoints send no CORS headers: it fetches them server-side
 * and re-serves with CORS, caching a week at the edge so item/spell lookups are
 * nearly free and shared across everyone.
 *
 *   GET /item/<id>?bonus=a:b:c   -> Wowhead tooltip JSON (cached 1 week)
 *   GET /spell|/zone|/npc/<id>   -> Wowhead tooltip JSON
 *   GET /itemxml/<id>            -> Wowhead item XML (drop-source zone ids)
 *
 * Var (wrangler.toml): ALLOWED_ORIGIN — your Pages origin, or "*". No secrets.
 */
const WOWHEAD = "https://nether.wowhead.com/tooltip/item/";

function corsHeaders(env) {
  // ALLOWED_ORIGIN is a single value ("*" or one origin). Echoing it verbatim is
  // already the enforcement: with a specific origin the browser blocks any other
  // request whose Origin doesn't match the header.
  const value = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After, X-Cache",
    "Vary": "Origin",
  };
}

// Proxy a Wowhead tooltip/XML endpoint with a week-long edge cache (keyed by the
// upstream URL). Shared by the /item, /spell, /zone, /itemxml routes.
async function wowheadProxy(ctx, ch, target, contentType = "application/json") {
  const cache = caches.default;
  const cacheKey = new Request(target);
  let resp = await cache.match(cacheKey);
  if (!resp) {
    const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" } });
    resp = new Response(await r.text(), {
      status: r.status,
      headers: { "Content-Type": contentType, "Cache-Control": "max-age=604800" },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  }
  return new Response(await resp.text(), { headers: { ...ch, "Content-Type": contentType } });
}

export default {
  async fetch(req, env, ctx) {
    const ch = corsHeaders(env);
    if (req.method === "OPTIONS") return new Response(null, { headers: ch });
    const url = new URL(req.url);

    try {
      // Wowhead proxies (all week-cached). /item carries an optional bonus query;
      // /itemxml is XML; the rest are tooltip JSON.
      if (url.pathname.startsWith("/item/") && req.method === "GET") {
        const id = encodeURIComponent(url.pathname.slice("/item/".length));
        const bonus = url.searchParams.get("bonus");
        return wowheadProxy(ctx, ch, WOWHEAD + id + (bonus ? `?bonus=${encodeURIComponent(bonus)}` : ""));
      }
      if (url.pathname.startsWith("/spell/") && req.method === "GET") {
        const id = encodeURIComponent(url.pathname.slice("/spell/".length));
        return wowheadProxy(ctx, ch, "https://nether.wowhead.com/tooltip/spell/" + id);
      }
      // Zone tooltip: resolve a Wowhead zone id to its name (the instance an item
      // drops in).
      if (url.pathname.startsWith("/zone/") && req.method === "GET") {
        const id = encodeURIComponent(url.pathname.slice("/zone/".length));
        return wowheadProxy(ctx, ch, "https://nether.wowhead.com/tooltip/zone/" + id);
      }
      // NPC tooltip: a boss's map.zone gives the instance when the item doesn't.
      if (url.pathname.startsWith("/npc/") && req.method === "GET") {
        const id = encodeURIComponent(url.pathname.slice("/npc/".length));
        return wowheadProxy(ctx, ch, "https://nether.wowhead.com/tooltip/npc/" + id);
      }
      // Item XML: the tooltip JSON omits the drop source's zone id; the XML's
      // <json> block carries `sourcemore` (zone id per source).
      if (url.pathname.startsWith("/itemxml/") && req.method === "GET") {
        const id = encodeURIComponent(url.pathname.slice("/itemxml/".length));
        return wowheadProxy(ctx, ch, "https://www.wowhead.com/item=" + id + "&xml", "application/xml");
      }

      if (url.pathname === "/") return new Response("wcl-proxy ok", { headers: ch });
      return new Response("not found", { status: 404, headers: ch });
    } catch (e) {
      return json({ error: String(e) }, 500, ch);
    }
  },
};

function json(obj, status, ch) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...ch, "Content-Type": "application/json" },
  });
}
