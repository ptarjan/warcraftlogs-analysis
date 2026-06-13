# CLAUDE.md — working in this repo

> **What goes where:** README.md is for humans (what it is, how to run/deploy,
> usage, the prose lessons). CLAUDE.md is for agents editing the code — terse
> rules, gotchas, workflow — and links to the README for detail instead of
> repeating it. "How do I use it?" → README. "What must I not break?" → here.

## The goal (north star)
**Pull a bunch of Warcraft Logs data, do a bunch of analysis, and spit out ONE
prioritized list of changes the player should make.** Everything else (overview,
diagnose, rotation, gear) is an *input* to that list. `prescribe.js` is the
payoff; the list is sorted **biggest-DPS-first by the impact actually shown**.

## Architecture
- `docs/` — static front-end (GitHub Pages), ES modules, runs the analysis in the
  browser and streams output live. `app.js` wires the UI and runs every section.
- `worker/` — Cloudflare Worker holding the WCL secret; proxies WCL GraphQL +
  Wowhead tooltips, adds CORS, caches, absorbs 429s. The browser needs it
  (secret + CORS); **Node does not**.
- `cli.mjs` — command-line runner. `wcl.js` is **dual-mode**: browser → Worker,
  Node → straight to WCL (OAuth) + Wowhead. CLI needs only credentials.
- Each analysis module exports `run(log, …)` (gear: `audit`) AND a data function
  (`gearFindings`, `rotationFindings`, …) so `prescribe.js` can fold findings
  into the list.

## Hard rules (these are why earlier versions were wrong)
- **Class-agnostic, always.** It must work for all 39 specs. NEVER hard-code
  ability names, priorities, or stat weights — derive from the data and the
  field. (The big bug: assuming Tiger Palm was a filler; an empowered Tiger Palm
  is the biggest hit.)
- **A "big" hit is usually a crit, not a proc.** Read `hitType` (2 = crit). Only
  outsized NON-crit hits are a real proc worth recommending; crit-driven big hits
  are stat+comp, not a rotation lever.
- **Only recommend a stat change with a concrete HOW** (which item to
  swap/recraft). If there's no mechanism, say it's not actionable and why — a
  stat gap is often gear/comp-locked.
- **Derive the stat priority** (`detectPriority`), never assume crit.
- **The list order must match the displayed `% DPS`** — sort by `impactScore`,
  not an internal proxy.
- Lessons go in as **behavior** (and a test), NOT as comments in the analysis.

## More gotchas
See README → "Lessons baked in". Highlights: match buffs by keyword not exact
name; ranked parses use ilvl-at-time (use highest-ilvl kill); Heroic vs Mythic
percentiles aren't comparable; secondary stats live in CombatantInfo *events*;
`sourceID`-filtered Casts/Buffs *tables* return empty (map names by class);
crafted item stats + embellishments only render with the item's bonus IDs; tier
needs 4 of 5 (one flex slot); auto-attack is melee-only (hunters=75, casters
none); compare uptime/range to peers on the SAME fight (intermissions).

## Dev workflow
- **Tests:** `npm test` (zero-dep `node:test`, mocked fetch + localStorage). Add
  a test when you fix a logic bug; keep it green.
- **Worktrees** (`warcraftlogs-analysis2/3/4`) all push to **master**:
  `git pull --rebase origin master` before pushing; expect to rebase often since
  several Claudes share the branch.
- **Secrets:** WCL creds live in `.env` / `worker/.dev.vars` / `wrangler secret`
  — all gitignored. Never commit them; grep before pushing.
- **Rate limits:** one shared hourly WCL point budget. The Worker caches GraphQL
  by query hash and the client coalesces/sessions-caches; still, back-to-back
  full runs can 429 (handled with backoff). Don't add redundant queries.
