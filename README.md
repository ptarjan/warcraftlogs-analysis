# warcraftlogs-analysis

A browser app that analyzes a Warcraft Logs character's DPS against the field —
with the statistical controls that make the conclusions actually hold up — then
hands back a prioritized to-do list. Built for Brewmaster Monk but parameterized
for any class/spec, and it auto-detects the current raid tier each season.

It runs as a **static front-end on GitHub Pages** plus a tiny **Cloudflare
Worker** that holds your WCL API secret and proxies WCL / Wowhead (the browser
can't do either: the secret would be public, and neither API sends CORS
headers). All four analyses run client-side, streaming results live as they
compute.

```
GitHub Pages (docs/)              Cloudflare Worker (worker/)
┌────────────────────┐   fetch   ┌──────────────────────────────┐
│ analysis runs in    │ ────────► │ holds WCL_CLIENT_ID/SECRET    │
│ your browser, JS     │ ◄──────── │  POST /wcl  -> GraphQL + token │
│ (live output)        │   CORS    │  GET  /item -> Wowhead tooltip │
└────────────────────┘    ok     └──────────────────────────────┘
```

## What it checks (and why)

This grew out of a long investigation into "why am I not 99th percentile?" Most
obvious answers turned out to be wrong; these are the comparisons that survived:

- **Overview** — per-boss kill percentiles for a difficulty. Remember:
  **percentiles are kills-only** and population-relative.
- **Item-level-matched comparison** — DPS, casts/min, active time, and targets
  vs peers at *your* item level, so gear level isn't a confound.
- **Duration control** — compares your DPS only to peers who killed in a similar
  time, so a long progression kill isn't mistaken for low output.
- **Secondary-stat allocation** — crit/haste/mastery/vers split (from
  `CombatantInfo` events) vs the field.
- **Timeline diagnosis** — for every GCD gap, cross-references auto-attack
  swings: autos kept swinging → **in range, not pressing** (hesitation/latency);
  autos stopped too → **out of range / moving**. Normalized vs peers on the SAME
  fight, so intermissions cancel out.
- **Gear audit** — reads every item's REAL secondary stats (Wowhead tooltip API)
  and compares slot-by-slot to the top-DPS field; detects embellishments and
  re-stattable crafted gear via bonus IDs.
- **Prescription** — aggregates all of the above into one ordered to-do list,
  each item with a rough DPS-impact estimate. This is the one to read.

## Deploy (free, ~10 minutes)

You need a [Cloudflare](https://dash.cloudflare.com/sign-up) account (free
Workers, no credit card) and a [WCL API client](https://www.warcraftlogs.com/api/clients/).

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login                       # opens browser
npx wrangler secret put WCL_CLIENT_ID    # paste your client id
npx wrangler secret put WCL_CLIENT_SECRET # paste your secret
npx wrangler deploy                      # prints https://wcl-proxy.<you>.workers.dev
```

Optionally lock the proxy to your Pages origin: set `ALLOWED_ORIGIN` in
`worker/wrangler.toml` to e.g. `https://<you>.github.io` and redeploy.

### 2. Publish the front-end on GitHub Pages

Set the Worker URL in `docs/config.js` (the `FALLBACK` constant), commit, then in
the repo: **Settings → Pages → Build from a branch → `master` / `/docs`**. Your
app appears at `https://<you>.github.io/warcraftlogs-analysis/`.

(You can also point an already-published page at a different proxy without
editing the file, via `?worker=https://...` or the **Settings** panel on the
page — handy for testing.)

## Run locally

```bash
# Terminal 1 — the Worker (reads worker/.dev.vars for secrets)
cd worker
cp ../.env.example .dev.vars   # then fill in your WCL id/secret
npx wrangler dev               # http://localhost:8787

# Terminal 2 — serve the static front-end
cd docs && python3 -m http.server 8000
# open http://localhost:8000/?worker=http://localhost:8787
```

## Command line (no Worker)

Under Node the secret is safe locally and there's no CORS, so the CLI talks
straight to WCL/Wowhead — **no Worker needed**, just credentials:

```bash
# credentials via env, .env, or worker/.dev.vars
export WCL_CLIENT_ID=...  WCL_CLIENT_SECRET=...
node cli.mjs "Hadryan" proudmoore US
node cli.mjs "Hadryan" proudmoore US --only prescribe
node cli.mjs "Name" server EU --class Monk --spec Brewmaster --difficulty 4
```

`cli.mjs` shims the one browser global the analyses use (`localStorage`, for
gear.js's item cache — persisted to `.cli-cache.json`) and calls the same
`run()`/`audit()` functions the web UI does. `wcl.js` is dual-mode: browser →
Worker, Node → direct.

## Tests

Zero-dependency, using Node's built-in runner (mocked fetch + localStorage shim,
no network):

```bash
npm test          # node --test test/*.test.mjs
```

Covers the regression-prone bits: Wowhead tooltip parsing (stats / embellished /
unique / item level), the dual-mode WCL client (direct-to-WCL, PrivateReport,
query coalescing), and a smoke test that the browser modules import under Node.

## Lessons baked in (don't relearn these)

- Buff/consumable names vary by rank/tier (`"Hearty Well Fed"` vs `"Well Fed"`).
  **Match buffs by keyword, never exact string.**
- A character's ranked parses are logged at the **item level at the time** —
  usually mid-progression. Use the highest-ilvl / most recent kill for current
  gear, or you'll critique stale equipment.
- Heroic vs Mythic percentiles are **not** comparable; the pools differ.
- `playerDetails.combatantInfo` is often empty — secondary stats come from
  `events(dataType: CombatantInfo)`, keyed by `sourceID`.
- "What the highest-CRIT players wear in a slot" is NOT the crit item for that
  slot. Read ACTUAL item stats; compare item *choices* against top-DPS players.
- WoW only exposes item IDs in logs; real per-item stats come from Wowhead's
  tooltip API, and **crafted gear shows 0/0/0/0 without its bonus IDs** (which
  also reveal the Embellishment).
- Uptime/range stats MUST be compared to peers on the same fight —
  intermissions otherwise look like your mistakes.
- Your WCL API key has an hourly request limit; a full analysis makes many
  calls, so back-to-back runs can hit a 429 (raise it via the WCL Patreon).

## Files

- `worker/src/index.js` — the Cloudflare Worker (secret-holding WCL/Wowhead proxy).
- `docs/wcl.js` — browser client for the Worker (GraphQL + tooltips).
- `docs/core.js` — shared constants, formatting, and low-level fetchers.
- `docs/analyze.js` — overview + ilvl/duration-controlled comparison.
- `docs/diagnose.js` — comparative timeline root-cause diagnosis.
- `docs/gear.js` — automatic gear audit (real item stats vs the field).
- `docs/prescribe.js` — the prioritized, actionable prescription.
- `docs/app.js` / `docs/index.html` — the UI.
