# warcraftlogs-analysis

A browser app that analyzes a Warcraft Logs character's DPS against the field —
with the statistical controls that make the conclusions actually hold up — then
hands back a prioritized to-do list. Built for Brewmaster Monk but parameterized
for any class/spec, and it auto-detects the current raid tier each season.

It runs as a **static front-end on GitHub Pages** with two ways to reach the WCL
API — and **no secret in the page** either way. All four analyses run
client-side, streaming results live as they compute.

- **Anonymous (default):** a visitor just types a character. Requests go through
  a tiny **Cloudflare Worker** that holds the shared app secret and proxies WCL /
  Wowhead (also caching, and absorbing rate limits across everyone).
- **Connected (optional):** the user clicks **Connect** and authorizes via OAuth
  **PKCE "public client"** — no secret, no proxy. The browser then uses *their
  own* token directly against `/api/v2/user`, spending their own rate budget and
  reaching their private logs.

```
GitHub Pages (docs/)
┌───────────────────────┐  anon ─► Cloudflare Worker ─► WCL /api/v2/client
│ analysis runs in your  │          (holds shared secret, caches, CORS)
│ browser, streams live  │  conn ─► WCL /api/v2/user  (user's own PKCE token,
└───────────────────────┘          direct, no proxy — CORS is open)
```

> The CLI is a third path: under Node the secret is safe locally, so it uses
> client-credentials directly (no Worker, no browser).

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

## Deploy (free)

You need two WCL clients (one of each kind) and, for the anonymous path, a free
[Cloudflare](https://dash.cloudflare.com/sign-up) account.

### 1. Anonymous path — deploy the Worker

A *confidential* [WCL client](https://www.warcraftlogs.com/api/clients/) (leave
"Public Client" unchecked) gives you a client id + secret. The Worker holds them
so visitors need no login:

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put WCL_CLIENT_ID      # paste id
npx wrangler secret put WCL_CLIENT_SECRET  # paste secret
npx wrangler deploy                        # prints https://wcl-proxy.<you>.workers.dev
```

Put that URL in `docs/config.js` (`FALLBACK`). Optionally lock it to your Pages
origin via `ALLOWED_ORIGIN` in `worker/wrangler.toml`. (Deploys also run from
GitHub Actions — see `.github/workflows/deploy-worker.yml`.)

### 2. Connected path — create a "public client"

A second, *public* client powers the optional **Connect** button. At
<https://www.warcraftlogs.com/api/clients/>:

- **Name:** anything descriptive.
- **Redirect URLs:** your Pages URL **exactly**, e.g.
  `https://<you>.github.io/warcraftlogs-analysis/` (trailing slash included).
  Add `http://localhost:8000/` too if you'll test locally.
- **Public Client:** ☑ **check it** — enables PKCE; there is **no secret**.

Copy its **client id** into `docs/config.js` (`CLIENT_ID`). Not sensitive —
the redirect-URL allow-list is what protects the flow.

### 3. Publish on GitHub Pages

Commit, then **Settings → Pages**: the included workflow builds `docs/` (esbuild,
content-hashed) and deploys `dist/`. Your app appears at
`https://<you>.github.io/warcraftlogs-analysis/` — type a character to analyze
anonymously, or click **Connect** to use your own account.

## Run locally

```bash
npm install          # esbuild
npm run build        # -> dist/
cd dist && python3 -m http.server 8000   # open http://localhost:8000/
```

Anonymous mode works immediately (it uses the deployed Worker). The redirect URI
is computed from the page URL, so register `http://localhost:8000/` on the public
client (step 2) for the local **Connect** to work.

## Command line (no browser, no OAuth)

The CLI uses the **client-credentials** flow against `/api/v2/client` — the
secret is safe locally and there's no CORS, so it talks straight to WCL/Wowhead.
Create a *confidential* client (or reuse one) and provide its id + secret:

```bash
# credentials via env, .env, or worker/.dev.vars
export WCL_CLIENT_ID=...  WCL_CLIENT_SECRET=...
node cli.mjs "Hadryan" proudmoore US
node cli.mjs "Hadryan" proudmoore US --only prescribe
node cli.mjs "Name" server EU --class Monk --spec Brewmaster --difficulty 4
```

`cli.mjs` shims the one browser global the analyses use (`localStorage`, for
gear.js's item cache — persisted to `.cli-cache.json`) and calls the same
`run()`/`audit()` functions the web UI does. `wcl.js` is multi-mode: **Node** uses
client-credentials against `/api/v2/client`; the **browser** uses the visitor's
own PKCE token against `/api/v2/user` when connected, else falls back to the
Worker proxy. Node and connected sessions hit Wowhead directly.

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
- WCL enforces an hourly request limit **per token**; a full analysis makes many
  calls, so back-to-back runs can hit a 429 (handled with backoff; raise the cap
  via the WCL Patreon). With PKCE each user spends their own budget.
- **Never hard-code class abilities, priorities, or stat weights.** It must work
  for all 39 specs. Deriving "Tiger Palm is a filler" was wrong — an empowered
  Tiger Palm is the biggest hit. Derive everything from the data and the field;
  if you can't, ask the player, don't assume.
- **A "big" hit is usually a crit, not a proc.** Read `hitType` (2 = crit).
  Outsized hits that are all crits mean the player needs *crit + raid buffs*
  (stat/comp, not actionable in the rotation), not a "missed empowerment button."
  Only outsized NON-crit hits indicate a real proc to maintain.
- **Derive the stat priority** from what the field stacks (`detectPriority`),
  never assume crit. And only tell someone to raise a stat with a concrete HOW
  (which item to swap/recraft) — otherwise say it's not actionable and why.
- **Auto-attack is melee-only (ability 1).** Hunters use Auto Shot (75); casters
  have none. Without autos you can't tell "out of range" from "not pressing", so
  don't label caster gaps as range problems.
- **Tier sets need only 4 of 5 pieces** — one is a free "flex" slot. Don't
  suggest swapping a tier piece for stats; the flex slot is the swappable one,
  and which 4 to wear is the player's call (it's combinatorial).
- **A `sourceID`-filtered Casts/Buffs table returns empty abilities/auras** —
  build ability/aura name maps by class (or use `sourceID` only on `events`).
- A crit/secondary gap is often **gear- or comp-locked** (your items are already
  maxed for that stat): real, but not something to grind the rotation over.

## Files

- `worker/src/index.js` — Cloudflare Worker for the anonymous path (holds the
  shared secret, proxies + caches WCL/Wowhead, absorbs 429s).
- `docs/config.js` — client id, worker URL, endpoints, redirect URI, `IS_NODE`.
- `docs/auth.js` — OAuth PKCE (connect / token / redirect callback), browser-only.
- `docs/wcl.js` — WCL GraphQL + Wowhead tooltips (Node creds / browser PKCE / proxy).
- `docs/core.js` — shared constants, formatting, and low-level fetchers.
- `docs/analyze.js` — overview + ilvl/duration-controlled comparison.
- `docs/diagnose.js` — comparative timeline root-cause diagnosis.
- `docs/gear.js` — automatic gear audit (real item stats vs the field).
- `docs/prescribe.js` — the prioritized, actionable prescription.
- `docs/app.js` / `docs/index.html` — the UI.
