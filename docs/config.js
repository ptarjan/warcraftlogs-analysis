// Set this to your deployed Worker URL (wrangler prints it after `deploy`,
// e.g. https://wcl-proxy.<your-subdomain>.workers.dev).
// You can also override at runtime with ?worker=https://... in the page URL.
const FALLBACK = "https://wcl-proxy.curly-unit-b9e0.workers.dev";

const fromQuery = new URLSearchParams(location.search).get("worker");
const fromStore = localStorage.getItem("workerUrl");
export const WORKER_URL = (fromQuery || fromStore || FALLBACK).replace(/\/$/, "");
if (fromQuery) localStorage.setItem("workerUrl", WORKER_URL);
export const WORKER_CONFIGURED = WORKER_URL && !WORKER_URL.includes("example.workers.dev");
