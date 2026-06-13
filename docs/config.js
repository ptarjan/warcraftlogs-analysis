// Set this to your deployed Worker URL (wrangler prints it after `deploy`,
// e.g. https://wcl-proxy.<your-subdomain>.workers.dev).
// You can also override at runtime with ?worker=https://... in the page URL.
const FALLBACK = "https://wcl-proxy.curly-unit-b9e0.workers.dev";

// Browser-only globals are guarded so this module also imports cleanly under
// Node (the CLI), where there's no Worker -- wcl.js talks to WCL directly there.
const hasLoc = typeof location !== "undefined";
const hasLS = typeof localStorage !== "undefined";
const fromQuery = hasLoc ? new URLSearchParams(location.search).get("worker") : null;
const fromStore = hasLS ? localStorage.getItem("workerUrl") : null;
export const WORKER_URL = (fromQuery || fromStore || FALLBACK).replace(/\/$/, "");
if (fromQuery && hasLS) localStorage.setItem("workerUrl", WORKER_URL);
export const WORKER_CONFIGURED = WORKER_URL && !WORKER_URL.includes("example.workers.dev");

// True when running under Node (the CLI): go straight to WCL, no Worker needed.
export const IS_NODE = typeof process !== "undefined" && !!(process.versions && process.versions.node);
