# warcraftlogs-analysis

A browser app that analyzes a Warcraft Logs character's DPS against the field —
with the statistical controls that make the conclusions actually hold up — then
hands back a prioritized to-do list. Built for Brewmaster Monk but parameterized
for any class/spec, and it auto-detects the current raid tier each season.

It runs as a **static front-end on GitHub Pages**, **connect-only** and with
**no secret anywhere in the page**. All four analyses run client-side, streaming
results live as they compute.

- **Connect required:** click **Connect** and authorize via OAuth **PKCE "public
  client"** (no secret). The browser then uses *your own* token directly against
  `/api/v2/user` — spending your own hourly rate budget and reaching your private
  logs. A full analysis is many heavy WCL requests, so a shared/proxied budget
  couldn't carry it; running on each user's own budget is what makes it scale.
- **Analyze anyone:** once connected you can analyze **any** character — your own
  in a click, or a friend's by name (a user token can query any public character).

```
GitHub Pages (docs/)
┌───────────────────────┐  WCL  ─► WCL /api/v2/user  (your own PKCE token,
│ analysis runs in your  │          direct — CORS is open, no secret, no proxy)
│ browser, streams live  │  Wowhead ─► tiny Cloudflare Worker (CORS + week cache;
└───────────────────────┘            NO secret — Wowhead just lacks CORS headers)
```

> The CLI is a second path: under Node a secret is safe locally, so it uses
> client-credentials directly against `/api/v2/client` (no Worker, no browser).

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
- **DPS over the fight** — a chart of your damage curve across the kill overlaid on
  the ilvl-matched field's band (median + 25–75%), then a read on your biggest dip.
  Curves are **aligned by phase** (each phase resampled separately) so a boss phase
  someone clears faster doesn't smear the comparison — the dip is pinned to a real
  phase, not a blurry "late in the fight".
- **Gear audit** — reads every item's REAL secondary stats (Wowhead tooltip API)
  and compares slot-by-slot to the top-DPS field; detects embellishments and
  re-stattable crafted gear via bonus IDs.
- **Prescription** — aggregates all of the above into one ordered to-do list,
  each item with a rough DPS-impact estimate. This is the one to read.

## Raid progression (a second flow)

Same data, same caches — a different question. The **Raid progression** tab (top
of the page, once connected) analyzes a whole **night of pulls** on a boss and
hands the *group* a few actionable, named changes to get the kill — driven by
**wipes, deaths, phase progress, and the DPS gate**, not one character's peer gap.

- **Input:** paste a Warcraft Logs **report URL** (or pick a recent raid night).
- **What it finds:** the **wall** (where recent wipes keep ending — phase +
  boss-% bucket); **leading causes** — the mechanic and players whose **early**
  deaths (well before the wipe, not the everyone-dies-at-the-end cascade) tip
  pulls over; and a **DPS check** sized from an estimated boss HP vs the field's
  own kill time (no hard-coded enrage), naming the lowest contributors. Crucially
  it does **not** blame the players who die *in* the wipe — when the whole raid
  goes down together at the wall, that's a DPS/enrage or raid-wide mechanic, not
  individual deaths.
- **Backtest:** it reads every pull to show the trend toward a kill, and flags a
  **roster change** that coincided with deeper progress.
- **Live (opt-in):** tick **Auto-reload** during raid — it re-checks the report's
  fight list every 60s (one cheap, cache-bypassing query) and only re-analyzes when
  a pull is actually added or ends; it pauses entirely while the browser tab is
  hidden and stops when the boss dies.

**Quota-bounded by design.** A finished report's pulls/deaths/roster/damage tables
are immutable, so they're cached forever — opening (or backtesting over) a report
costs ~6 WCL requests the first time and **zero** on re-open. The recent-nights
picker is 1–2 cached character queries. The only repeated spend is the opt-in live
poll: ~1 cheap request per 60s, paused when you're not looking. Code:
`docs/progression.js`.

## Deploy (free)

You need one *public* WCL client for the browser, and (optionally) a free
[Cloudflare](https://dash.cloudflare.com/sign-up) account for the Wowhead proxy.

### 1. Create a "public client" (powers Connect)

A *public* [WCL client](https://www.warcraftlogs.com/api/clients/) powers the
**Connect** button. At <https://www.warcraftlogs.com/api/clients/>:

- **Name:** anything descriptive.
- **Redirect URLs:** your Pages URL **exactly**, e.g.
  `https://<you>.github.io/warcraftlogs-analysis/` (trailing slash included).
  Add `http://localhost:8000/` too if you'll test locally.
- **Public Client:** ☑ **check it** — enables PKCE; there is **no secret**.

Copy its **client id** into `docs/config.js` (`CLIENT_ID`). Not sensitive —
the redirect-URL allow-list is what protects the flow.

### 2. Deploy the Wowhead proxy (no secret)

Wowhead's tooltip endpoints send no CORS headers, so the gear audit reads them
through a tiny Worker that CORS-wraps + week-caches them. It holds **no secret**
(the app is connect-only — WCL is hit directly with the user's token):

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy   # prints https://wcl-proxy.<you>.workers.dev
```

Put that URL in `docs/config.js` (`FALLBACK`). (Deploys also run from GitHub
Actions — see `.github/workflows/deploy-worker.yml`.)

### 3. Publish on GitHub Pages

Commit, then **Settings → Pages**: the included workflow builds `docs/` (esbuild,
content-hashed) and deploys `dist/`. Your app appears at
`https://<you>.github.io/warcraftlogs-analysis/` — click **Connect**, then
analyze your own characters or any friend by name.

## Run locally

```bash
npm install          # esbuild
npm run build        # -> dist/
cd dist && python3 -m http.server 8000   # open http://localhost:8000/
```

The redirect URI is computed from the page URL, so register
`http://localhost:8000/` on the public client (step 1) for the local **Connect**
to work. (The Wowhead proxy uses the deployed Worker.)

## Command line (no browser, no OAuth)

The CLI uses the **client-credentials** flow against `/api/v2/client` — the
secret is safe locally and there's no CORS, so it talks straight to WCL/Wowhead.
Create a *confidential* client (or reuse one) and provide its id + secret:

```bash
# credentials via env, .env, or worker/.dev.vars
export WCL_CLIENT_ID=...  WCL_CLIENT_SECRET=...
node cli.mjs "Hadryan" proudmoore US --allow-fetch   # analyze (spends your hourly WCL points)
node cli.mjs "Hadryan" proudmoore US                 # CACHE-ONLY: only what's already cached, $0
node cli.mjs "Hadryan" proudmoore US --only prescribe --allow-fetch
node cli.mjs "Name" server EU --class Monk --spec Brewmaster --difficulty 4 --allow-fetch

# Raid progression: backtest a night of pulls from the terminal
node progression-cli.mjs "https://www.warcraftlogs.com/reports/aBcD1234" --allow-fetch
node progression-cli.mjs aBcD1234 --enc 2902 --allow-fetch    # pin a specific encounter id
```

**Fetching is opt-in.** A run is **cache-only by default** — it never touches WCL and
spends zero points; an uncached query just fails fast. Pass **`--allow-fetch`** to pull
from WCL (which spends your shared hourly point budget). This is the single-writer rule:
only the run you explicitly bless spends the budget, so background/parallel/agent runs
can't drain it. The browser app is unaffected (it always fetches, on your own token).

`--allow-fetch` is a *request* — it's only honored after a **budget gate** clears:
(1) a points **reserve** must remain (won't bottom out the budget), and (2) a
**single-fetcher lock** (a file next to the cache) must be free, so two `--allow-fetch`
runs can't fetch at once. If either fails, the run prints why and stays cache-only. A
crashed run's lock is auto-stolen (dead-PID / stale check), so it can't wedge forever.

Class, spec, difficulty, and gear priority are **auto-detected from your logs**
(same as the web app) — the flags only override individual fields. `cli.mjs`
shims the one browser global the analyses use (`localStorage`, for gear.js's item
cache — persisted to `.cli-cache.json`) and calls the same `run()`
functions the web UI does. `wcl.js` is two-mode: **Node** uses client-credentials
against `/api/v2/client`; the **browser** uses the user's own PKCE token against
`/api/v2/user` (connect-only — no anonymous path). Node hits Wowhead directly;
the browser reads Wowhead through the Worker (CORS). The Node path persists
GraphQL results to `.gql-cache.json` (6 h TTL) so iterating on one character
doesn't re-spend points or trip the per-IP 429.

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
  **Match buffs by keyword, never exact string.** And the food buff is a *generic
  rank* (`"Well Fed"`), not the food item — so a food→food "swap" can't say which
  food to eat (and `"Hearty Well Fed"` is the *more* common buff, so a small-field
  top of plain `"Well Fed"` points at a downgrade). Food is `genericBuff: true`:
  its swap lever is suppressed; only "you ate none → eat food" surfaces. Flasks/
  potions/oils/runes name the specific item, so they keep swaps.
- A character's ranked parses are logged at the **item level at the time** —
  usually mid-progression. "Current" = the **most recent kill within 1 ilvl of
  your best** (`bestRank`/`bestKill`), NOT the single highest-ilvl kill: a lucky
  early high-ilvl drop would otherwise hide enchants/gems/consumables you've
  fixed since. Gear is a snapshot, so recency matters for the things that change
  without changing ilvl.
- Heroic vs Mythic percentiles are **not** comparable; the pools differ.
- `playerDetails.combatantInfo` is often empty — secondary stats come from
  `events(dataType: CombatantInfo)`, keyed by `sourceID`.
- "What the highest-CRIT players wear in a slot" is NOT the crit item for that
  slot. Read ACTUAL item stats; compare item *choices* against top-DPS players.
- WoW only exposes item IDs in logs; real per-item stats come from Wowhead's
  tooltip API, and **crafted gear shows 0/0/0/0 without its bonus IDs** (which
  also reveal the Embellishment).
- An item's **source comes from Wowhead, no hardcoded boss→dungeon table** — we
  lead with the instance ("dropped in Windrunner Spire"), boss only as fallback.
  The item **XML**'s `<json>.sourcemore` carries the drop sources; resolve the
  instance two ways so it works for **any** item: the source may have the **zone
  id** (`z`) directly, or just the **boss NPC id** (`ti`) — then the **NPC
  tooltip**'s `map.zone` gives the zone. The **zone tooltip** (`/tooltip/zone/`)
  names it. Match `sourcemore[].n` to the boss to disambiguate multi-source items.
  Resolve only the handful of items you recommend (cached). Embellished = crafted.
- **Gear advice is reconciled per slot — one plan per slot.** A slot earmarked
  for an embellishment (yours, or the combo we recommend) must NOT also get a
  "swap to a drop here" line; otherwise the list contradicts itself (the bug:
  Back recommended for both an embellishment and a haste cloak).
- Uptime/range stats MUST be compared to peers on the same fight —
  intermissions otherwise look like your mistakes.
- WCL enforces an hourly request limit **per token**; a full analysis makes many
  calls, so back-to-back runs can hit a 429 (handled with backoff; raise the cap
  via the WCL Patreon). With PKCE each user spends their own budget. Beyond that
  point budget, the **direct (Node) path can also trip a per-IP throttle**
  ("Too many requests from this IP address") that the browser dodges (it exits
  through the Worker's IPs and reuses the Worker cache). The CLI persists GraphQL
  results to `.gql-cache.json` so reruns are nearly free and don't re-trigger it.
- **Every HTTP call needs a timeout.** A no-timeout `fetch` once hung on a dead
  socket and froze a CLI run for 26 minutes; requests now abort after 45 s and
  the retry/backoff loop takes over.
- **Auto-detect class/spec/difficulty — never default to a class.** The CLI used
  to hard-default to Monk/Brewmaster; for any other character the analyses filter
  WCL tables by `sourceClass` and silently return *empty* (you'd see "No gear
  found" / "could not read casts"). Detect from the character's own kills
  (`detectContext`); flags only override. (Found via Hadron, a Guardian Druid.)
- **Never hard-code class abilities, priorities, or stat weights.** It must work
  for all 39 specs. Deriving "Tiger Palm is a filler" was wrong — an empowered
  Tiger Palm is the biggest hit. Derive everything from the data and the field;
  if you can't, ask the player, don't assume.
- **Compare ability USAGE (casts/min) to the field, not just per-hit damage.**
  The biggest lever for an underperformer is often pressing the wrong button --
  spamming an AoE ability on single-target, or never pressing the field's core
  spender / damage cooldown. `usageDivergence` surfaces under-used and over-used
  abilities purely from the field's rates (class-agnostic), and it's promoted
  high in the list (a wrong-button swap dwarfs a gear re-stat). Caveat: ability
  names map via *damage* abilities, so pure-buff cooldowns (no direct damage,
  e.g. Berserk) aren't tracked -- only damage-dealing presses.
- **A "big" hit is usually a crit, not a proc.** Read `hitType` (2 = crit).
  Outsized hits that are all crits mean the player needs *crit + raid buffs*
  (stat/comp, not actionable in the rotation), not a "missed empowerment button."
  Only outsized NON-crit hits indicate a real proc to maintain.
- **Anchor the answer on MEASURED DPS, not a sum of per-lever guesses.** We have
  your kill's DPS, the ilvl-matched field's, and the top parses' -- so the
  headline gap is real ("you 68k vs the field's 96k, 41% behind"). Break that gap
  into measured facts (lost GCD s/min, cast rates, buff uptimes, routing %). Only
  gear needs an estimate (a stat→DPS value wants a sim) -- say so; never present a
  summed estimate as if it were the measured total.
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

- `worker/src/index.js` — Cloudflare Worker: Wowhead tooltip CORS+cache proxy
  (no secret; the app hits WCL directly with the user's token).
- `docs/config.js` — client id, worker URL, endpoints, redirect URI, `IS_NODE`.
- `docs/auth.js` — OAuth PKCE (connect / token / redirect callback), browser-only.
- `docs/wcl.js` — WCL GraphQL (Node creds / browser PKCE) + Wowhead via the Worker.
- `docs/core.js` — shared constants, formatting, and low-level fetchers.
- `docs/overview.js` — overview + ilvl/duration-controlled comparison.
- `docs/timeline.js` — comparative timeline root-cause analysis.
- `docs/graph.js` — DPS-over-time chart vs the phase-aligned field band.
- `docs/gear.js` — automatic gear audit (real item stats vs the field).
- `docs/prescribe.js` — the prioritized, actionable prescription.
- `docs/app.js` / `docs/index.html` — the UI.
