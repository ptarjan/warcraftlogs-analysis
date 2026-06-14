# CLAUDE.md — working in this repo

> **What goes where:** README.md is for humans (what it is, how to run/deploy,
> usage, the prose lessons). CLAUDE.md is for agents editing the code — terse
> rules, gotchas, workflow — and links to the README for detail instead of
> repeating it. "How do I use it?" → README. "What must I not break?" → here.

## The goal (north star)
**Pull a bunch of Warcraft Logs data, do a bunch of analysis, and spit out ONE
prioritized list of changes the player should make.** Everything else (overview,
timeline, rotation, gear) is an *input* to that list. `prescribe.js` is the
payoff; the list is sorted **biggest-DPS-first by the impact actually shown**.

## Architecture
- `docs/` — static front-end (GitHub Pages), ES modules, runs the analysis in the
  browser and streams output live. `app.js` wires the UI and runs every section.
- **`wcl.js` has two paths, no secret in the page:**
  - Node (CLI) → client-credentials (env/.env) → `/api/v2/client`, direct.
  - browser → user's own PKCE token (`auth.js`) → `/api/v2/user`, direct (CORS
    is open). No token → `NeedsAuth`.
- **Connect-only (no anonymous path).** A full run is many heavy WCL requests, so
  every browser run spends the connected user's OWN hourly point budget — a
  shared/proxied budget can't carry it (this is why the anonymous Worker proxy
  was removed). Connect = PKCE public client (`CLIENT_ID` in `config.js`, not a
  secret). Once connected you can analyze ANY character (yours or a friend's) —
  the user token queries any public character, billed to that user.
- The `worker/` Cloudflare proxy now holds **no secret**: it only CORS+caches
  Wowhead tooltips (Wowhead sends no CORS headers). There is no `/wcl` route.
- A connected token that 401s throws `NeedsAuth` (reconnect); we clear the dead
  token so the active identity stays honest.
- Each analysis module exports `run(log, …)` (the card entrypoint — renders) AND
  a `…Findings` data function (`gearFindings`, `rotationFindings`,
  `timelineFindings`, …) that only computes. Keep compute and render separate.
- **Findings are the shared currency.** A finding is `{ dim, impact, label, text }`
  built with `DPS()/COMP()/INFO` + `finding()` from `core.js` — `impact` (a
  number) is the ONLY sort key, `label` is the matching display string (built
  together so they can't drift). Each domain owns its `…Levers(data)→Finding[]`
  (`gearLevers`, `rotationLevers`, `topParseLevers`); `prescribe.js` adds the
  cross-cutting ones (execution/consumables/enchants/stat-gap), concatenates,
  sorts by `impact`, splits yours-vs-comp, renders. Don't re-derive a finding's
  category from its text — set `dim` explicitly.
- **One fetch per report.** All report reads go through `core.reportCore` (one
  bundled, memoized query per `report+fight`); `test/loader.test.mjs` fails if any
  table/event is fetched twice across a full run. Don't add a parallel fetch path.
- **Second flow: raid progression** (`progression.js`, the "Raid progression" tab).
  Analyzes a whole report's PULLS to tell the GROUP what to change to kill the boss
  (wipes/deaths/phase/DPS-gate, not one character's peer gap). Same compute/render
  split: `progressionFindings(code,…)` computes, `run()` streams. Reuses the cache +
  the `finding()` model, but owns its OWN sorted list and Score constructors
  (`BLOCK`/`GATE`) and `dim`s (`Survival`/`DPSCheck`/`Mechanic`/`Roster`) — it does
  NOT feed `prescribe`. Budget-bounded: `reportFights` (1, all pull metadata) +
  `reportDeaths` (1, batched across pulls) + `reportRoster` (1) + `reportCore` on
  only the deepest+recent pulls. NEVER fetch tables per pull. Same hard rules apply:
  derive ability/boss names from data (`spellTooltip`/roster), no hard-coded enrage
  (size the DPS check from the field's own kill time), require a wipe cause to recur
  across ≥2 pulls before naming it.
- **Live report caching is the ONE exception to permanent report caching.** A
  live report's fight LIST grows mid-raid; `_isImmutable` keys off query text and
  can't tell live from finished, so `gql(q, retries, {fresh:true})` bypasses every
  read cache (and skips persisting) for the poll. Only `reportFights`/`reportDeaths`
  thread `fresh`; ended pulls' TABLES are immutable and stay cached. Don't widen
  `_isImmutable` — it's load-bearing for the "logged kills never change" model.
- camelCase all derived fields. Snake_case only for OAuth/HTTP wire formats.
- **Verify every WCL GraphQL field/arg against the schema — don't guess.** Before
  adding or changing a query, check `WCL-SCHEMA.md` (our verified query surface +
  the gotchas) and, for anything new, the official schema browser it links. A
  wrong field/selection often fails the *whole* query silently. Notably:
  `ReportActor.server` is a `String`, but `Server` (Character/rankings) is a
  `{id,name,slug,region}` object — don't conflate them.

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
- **The change-list must ADD UP to the measured gap** (`reconcileImpacts`): gap =
  comp + your concrete fixes + an explicit remainder. A big remainder is a
  *diagnostic*, NOT cosmetics — it means we're missing/mis-measuring a lever
  (the trinket lever was hiding there). Investigate it; never quietly absorb it.
- **A big gap at matched ilvl is PLAYSTYLE, not gear.** Sims model gear (~a few %
  at your ilvl); the gap to the field on the *same gear* is how you play —
  cooldown usage, which buttons and when, uptime. Surfacing that is the tool's
  whole purpose. NEVER punt a big remainder to "press faster" or "go sim it" —
  those are cop-outs. Explain the playstyle, or admit the breakdown is the gap to
  close *in this tool*.
- **Don't tell a ~99%-active player to "press faster."** You can't idle while
  ~99% active — suppress press-faster when `activePct >= 98` or you out-cast the
  field; the cast deficit is ability-MIX (defensive/low-APM GCDs), not idling.
- **Tanks are NOT special for DPS.** The ilvl-matched field is *fellow tanks*, so
  the gap is real and explainable (itemization toward crit, build, cooldowns) —
  don't excuse it as a "survival tradeoff." (Only true caveat: their damaging-cast
  count is confounded by defensive GCDs, which the activePct rule already handles.)
- Lessons go in as **behavior** (and a test), NOT as comments in the analysis.

## More gotchas
See README → "Lessons baked in". Highlights: match buffs by keyword not exact
name; "current" kill = MOST RECENT within 1 ilvl of your best (`bestRank`/
`bestKill`/`pickCurrentKill`), not the single highest-ilvl one, or recent
enchant/consumable fixes get hidden by an old lucky-drop kill (prescribe *re-broke*
this once by sorting kills by ilvl — flag a snapshot ≥7 days old); Heroic vs Mythic
percentiles aren't comparable; secondary stats live in CombatantInfo *events*;
`sourceID`-filtered Casts/Buffs *tables* return empty (map names by class);
crafted item stats + embellishments only render with the item's bonus IDs; tier
needs 4 of 5 (one flex slot); auto-attack is melee-only (hunters=75, casters
none); compare uptime/range to peers on the SAME fight (intermissions).
- **Cooldowns hide below `usageDivergence`'s 0.5/min floor** (filler-tuned).
  `cooldownGaps` covers the ~0.1–1.0/min band, sized from MEASURED damage-per-cast.
  BUT it only sees DAMAGE casts (castRate is built from the damage table), so
  **buff/pet cooldowns deal no direct cast damage and stay invisible** (Brewmaster's
  Weapons of Order = buff, Invoke Niuzao = pet). Those need buff-uptime / pet-damage
  analysis — still an OPEN lever (buff-uptime side).
- **A playstyle remainder can be a WEAK cast, not a MISSED one — but per-cast DAMAGE
  is too confounded to prove it.** A hard hit landing weaker than the field's same
  ability looks like an empowerment-timing miss, but comp re-attribution (Aug/PI),
  a boss's damage-taken debuff (e.g. Crown of the Cosmos), and stat scaling ALL make
  the field's per-cast bigger with nothing you did wrong. `perCastGaps` only SIZES the
  gap; it must NEVER be the claim. The real, unconfounded test is `empoweredShare`:
  what fraction of your hardest hit lands above 1.5× your OWN median (the empowered/
  in-window version) vs the field's same fraction. It's a within-player fraction, so
  a flat amp lifts both clusters and cancels. The EMPOWERMENT lever fires ONLY when
  your share trails the field's (≥12pp); when they match (or you're ahead), say so —
  the gap is per-cast stats/comp/fight-amp, NOT timing. (Hadryan empowers Tiger Palm
  40% vs the field's 22% → no lever; his gap is the boss debuff + comp + crit.) The
  advice is mechanic-agnostic ("land your hardest hit in its high-damage window",
  self-combo OR boss debuff) — never name the per-class mechanic.
- **Trinkets are effect-based** — `gear.js` deliberately skips them from stat
  swaps; `trinketLevers` flags a field-favored trinket you lack, sized by
  CONSENSUS (silent on a split field, where "lots of people run different
  trinkets" is itself the signal).
- **Immutable report data is cached forever** (`_isImmutable`: `report(code:…)`),
  rankings/world/character queries expire weekly — don't assume a cold cost for a
  character analyzed within the tier.
- **Benchmark the DPS gap on a REPRESENTATIVE kill** (`pickBenchmarkKill` = median
  parse within 1 ilvl), NOT the most-recent one. A tank's (or anyone's) most-recent
  kill can be an outlier survival/progression pull where they barely DPS'd →
  "217% behind" garbage that contradicts their own percentile. A huge unexplained
  remainder that contradicts the parse % is the tell. (Gear/setup is still read off
  that same kill, within the ilvl band; the staleness NOTE flags it if it's old.)
- **The damage/casts TABLES truncate to ~5 abilities/actor.** Full per-ability data
  needs cast EVENTS (all casts, see `allCastRate`) or a `sourceID`-filtered
  DamageDone table (returns the full ~15-ability breakdown, unlike the unfiltered
  one). Pet damage is a separate actor (`petOwner`) and folded into the owner's
  ranking DPS — isolate it with a `sourceID`-filtered table if you need it alone.

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
