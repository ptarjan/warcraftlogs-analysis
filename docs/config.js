// @ts-check
// Browser config. No secret ever lives in the page. Connect-only:
//   the user clicks Connect once (OAuth PKCE "public client", auth.js) and the
//   browser holds THEIR own token, calling /api/v2/user directly -- their own
//   rate budget + private logs. There is no anonymous/shared path.
// Node (the CLI) ignores all of this and uses client-credentials from env/.env.

// ---- PKCE public client (the "Connect" path) ---------------------------------
// CLIENT_ID is NOT a secret -- public clients have none, and the id is meant to
// ship in client code. From https://www.warcraftlogs.com/api/clients/ ("Public
// Client" checked).
export const CLIENT_ID = "a202d4cf-d4b3-4d30-b504-f4f79bdbd5dc";
export const AUTHORIZE_URL = "https://www.warcraftlogs.com/oauth/authorize";
export const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
export const USER_API_URL = "https://www.warcraftlogs.com/api/v2/user"; // PKCE/user tokens
export const CLIENT_API_URL = "https://www.warcraftlogs.com/api/v2/client"; // Node client-credentials
export const WOWHEAD_URL = "https://nether.wowhead.com/tooltip/item/";

// The redirect URI must EXACTLY match one registered on the WCL client. Derived
// from the current page so one build works on the deployed site AND localhost.
const hasLoc = typeof location !== "undefined";
export const REDIRECT_URI = hasLoc ? location.origin + location.pathname : "";

// ---- Cloudflare Worker (Wowhead tooltip CORS+cache proxy; no secret) ---------
// The deployed Worker URL (wrangler prints it). Override at runtime with
// ?worker=https://... in the page URL (persisted to localStorage).
const FALLBACK = "https://wcl-proxy.curly-unit-b9e0.workers.dev";
const hasLS = typeof localStorage !== "undefined";
const fromQuery = hasLoc ? new URLSearchParams(location.search).get("worker") : null;
const fromStore = hasLS ? localStorage.getItem("workerUrl") : null;
export const WORKER_URL = (fromQuery || fromStore || FALLBACK).replace(/\/$/, "");
if (fromQuery && hasLS) localStorage.setItem("workerUrl", WORKER_URL);
export const WORKER_CONFIGURED = !!WORKER_URL && !WORKER_URL.includes("example.workers.dev");

// True under Node (the CLI): credentials from env/.env, queries to /api/v2/client.
export const IS_NODE = typeof process !== "undefined" && !!(process.versions && process.versions.node);
