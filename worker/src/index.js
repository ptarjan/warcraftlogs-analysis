/**
 * Cloudflare Worker: the secret-holding proxy for the static front-end.
 *
 * The browser app can't hold the WCL client secret (it'd be public) and can't
 * call WCL/Wowhead directly (no CORS headers). This Worker solves both: it
 * keeps the secret server-side, does the OAuth client-credentials exchange, and
 * forwards requests with the right Authorization / CORS headers.
 *
 *   POST /wcl        body {query}      -> WCL GraphQL, bearer token added
 *   GET  /item/<id>?bonus=a:b:c        -> Wowhead tooltip JSON (cached)
 *
 * Secrets (set with `wrangler secret put`):
 *   WCL_CLIENT_ID, WCL_CLIENT_SECRET
 * Var (wrangler.toml): ALLOWED_ORIGIN — your Pages origin, or "*".
 */
const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const API_URL = "https://www.warcraftlogs.com/api/v2/client";
const WOWHEAD = "https://nether.wowhead.com/tooltip/item/";

// Cached within an isolate; a cold isolate just fetches one fresh token.
let cachedToken = null; // { access_token, expires_at }

async function getToken(env) {
  const now = Date.now() / 1000;
  if (cachedToken && cachedToken.expires_at > now + 60) return cachedToken.access_token;
  const auth = btoa(`${env.WCL_CLIENT_ID}:${env.WCL_CLIENT_SECRET}`);
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  const j = await r.json();
  cachedToken = { access_token: j.access_token, expires_at: now + (j.expires_in || 0) };
  return cachedToken.access_token;
}

function corsHeaders(req, env) {
  const allow = env.ALLOWED_ORIGIN || "*";
  const origin = req.headers.get("Origin") || "";
  // If an allow-list origin is configured, echo it only when it matches.
  const value = allow === "*" ? "*" : (origin === allow ? allow : allow);
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export default {
  async fetch(req, env, ctx) {
    const ch = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { headers: ch });
    const url = new URL(req.url);

    try {
      if (url.pathname === "/wcl" && req.method === "POST") {
        const { query } = await req.json();
        if (!query) return json({ error: "missing query" }, 400, ch);
        const token = await getToken(env);
        const r = await fetch(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        });
        const text = await r.text();
        return new Response(text, {
          status: r.status,
          headers: { ...ch, "Content-Type": "application/json" },
        });
      }

      if (url.pathname.startsWith("/item/") && req.method === "GET") {
        const id = url.pathname.slice("/item/".length);
        const bonus = url.searchParams.get("bonus");
        const target = WOWHEAD + encodeURIComponent(id) +
          (bonus ? `?bonus=${encodeURIComponent(bonus)}` : "");
        const cache = caches.default;
        const cacheKey = new Request(target);
        let resp = await cache.match(cacheKey);
        if (!resp) {
          const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" } });
          const text = await r.text();
          resp = new Response(text, {
            status: r.status,
            headers: { "Content-Type": "application/json", "Cache-Control": "max-age=604800" },
          });
          ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        }
        const body = await resp.text();
        return new Response(body, { headers: { ...ch, "Content-Type": "application/json" } });
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
