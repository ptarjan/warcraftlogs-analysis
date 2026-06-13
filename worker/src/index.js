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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fetch a GraphQL query from WCL, absorbing transient 429s server-side (honor
// Retry-After, capped backoff) so a rate-limit spike doesn't surface to the
// browser. Bounded so we never hold a request open too long.
async function wclFetch(env, query, tries = 3) {
  let lastText = "", lastStatus = 500, lastRetryAfter = null;
  for (let i = 0; i < tries; i++) {
    const token = await getToken(env);
    const r = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    lastStatus = r.status;
    lastText = await r.text();
    if (r.status !== 429) return { text: lastText, status: r.status, retryAfter: null };
    const ra = parseInt(r.headers.get("Retry-After") || "", 10);
    if (Number.isFinite(ra)) lastRetryAfter = ra;
    await sleep(Number.isFinite(ra) ? Math.min(10000, ra * 1000) : Math.min(8000, 1000 * 2 ** i));
  }
  return { text: lastText, status: lastStatus, retryAfter: lastRetryAfter };
}

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
    const ch = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { headers: ch });
    const url = new URL(req.url);

    try {
      if (url.pathname === "/wcl" && req.method === "POST") {
        const { query } = await req.json();
        if (!query) return json({ error: "missing query" }, 400, ch);

        // Cache GraphQL responses by query hash. WCL rankings / reports /
        // character data are static enough within the hour, so every parallel
        // tab and session shares one upstream fetch -- the main defense against
        // 429s on the shared hourly point budget.
        const cache = caches.default;
        const cacheKey = new Request(`https://wcl-cache.local/q/${await sha256hex(query)}`);
        const hit = await cache.match(cacheKey);
        if (hit) {
          const body = await hit.text();
          return new Response(body, {
            headers: { ...ch, "Content-Type": "application/json", "X-Cache": "HIT" },
          });
        }

        const { text, status, retryAfter } = await wclFetch(env, query);
        // Only cache clean, successful data responses (never errors / 429).
        let cacheable = false;
        if (status === 200) {
          try { const j = JSON.parse(text); cacheable = !!(j && j.data && !j.errors); } catch {}
        }
        if (cacheable) {
          // Logs are immutable history; cache 6h so repeat/overlapping runs and
          // every user share one upstream fetch -- the main defense against 429s.
          ctx.waitUntil(cache.put(cacheKey, new Response(text, {
            headers: { "Content-Type": "application/json", "Cache-Control": "max-age=21600" },
          })));
        }
        const wh = { ...ch, "Content-Type": "application/json", "X-Cache": "MISS" };
        if (retryAfter != null) wh["Retry-After"] = String(retryAfter); // surface reset hint
        return new Response(text, { status, headers: wh });
      }

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
