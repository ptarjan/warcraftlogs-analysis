// Client for the Cloudflare Worker proxy: WCL GraphQL + Wowhead tooltips.
import { WORKER_URL } from "./config.js";

export class PrivateReport extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a GraphQL query, returning the parsed `data`. Retries transient errors;
// throws PrivateReport on permission errors so callers can skip a report.
export async function gql(query, retries = 6) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    let r, j;
    try {
      r = await fetch(`${WORKER_URL}/wcl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      j = await r.json();
    } catch (e) {
      // Network/transport failure -- worth retrying with backoff.
      last = e;
      await sleep(1000 * (2 + attempt));
      continue;
    }
    if (j.errors) {
      const msg = JSON.stringify(j.errors);
      if (msg.includes("permission") || msg.includes("do not have")) throw new PrivateReport(msg);
      throw new Error(msg);
    }
    // Honor HTTP 429 rate limits with exponential backoff -- several parallel
    // sessions share one API client's hourly point budget.
    if (r.status === 429 || (j.error && /too many requests/i.test(j.error))) {
      last = new Error(j.error || "rate limited (429)");
      await sleep(Math.min(90000, 10000 * 2 ** attempt));
      continue;
    }
    if (j.error) throw new Error(j.error); // other non-GraphQL error
    if (!j.data) throw new Error("no data: " + JSON.stringify(j).slice(0, 200));
    return j.data;
  }
  throw last;
}

// Wowhead tooltip JSON for an item (real per-instance stats need the bonus IDs).
export async function itemTooltip(id, bonusIds) {
  const bonus = (bonusIds || []).map(String);
  const q = bonus.length ? `?bonus=${bonus.join(":")}` : "";
  const r = await fetch(`${WORKER_URL}/item/${id}${q}`);
  return await r.json();
}
