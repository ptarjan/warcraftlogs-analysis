# WCL GraphQL — our query surface, checked against the schema

**Always verify WCL GraphQL fields/args against the official schema before
assuming a shape.** Source of truth (browse in a real browser — Cloudflare 403s
scripted fetches):

- Official schema browser: <https://www.warcraftlogs.com/v2-api-docs/warcraft/>
- Or introspect the live endpoint with a GraphQL client (Altair, etc.).
- A community SDL dump (handy for grepping): the `wcl-graphql-schema.md` in
  `melnikov1512/wow-log-analyzer` on GitHub.

Every query we send lives in **`docs/core.js`** (plus the rate-limit ping in
`docs/wcl.js`). Last audited against the schema: 2026-06 — all fields/args below
are valid.

## Query roots (Query)
`characterData`, `worldData`, `reportData`, `userData`, `rateLimitData` — all used, all valid.

## What each call uses (verified)
- `characterData.character(name, serverSlug, serverRegion): Character`
  - `.id`, `.classID`, `.zoneRankings(difficulty)`, `.encounterRankings(encounterID, difficulty, metric)` → JSON.
  - `metric` enums: `dps` (CharacterRankingMetricType / CharacterPageRankingMetricType).
- `worldData.encounter(id).characterRankings(difficulty, className, specName, metric, page)` → JSON.
- `reportData.report(code).…`
  - `table(fightIDs, dataType, sourceID?, hostilityType?)` → JSON. `dataType`: TableDataType (`DamageDone`, `Healing`, `Casts`, `Buffs`, `Debuffs`, … `Resources`). `hostilityType`: `Enemies`.
    - **The `Healing` table JSON carries overheal** (verified live 2026-06): the UNFILTERED table's actor `entries[]` have an `overheal` field (effective `total` EXCLUDES it) — but their `abilities[]` do NOT. For PER-ABILITY overheal use the **sourceID-FILTERED** Healing table, whose `entries[]` ARE the abilities, each with `name`/`total`/`overheal` (`core.playerAbilities`/`healingBreakdown`). `DamageDone` has no overheal. `core.metricsFromTables` reads entry `overheal`/`overhealPct` defaulting absent→0, so a DPS run is unaffected. (Healer OVERHEALING lever.)
    - **Mana**: `events(dataType:Casts, includeResources:true)` rides a `classResources:[{amount,max,type,cost}]` snapshot on each cast — mana is `type:0` (`core.manaStats` → end-of-fight %, low-water, OOM). The dedicated `events(dataType:Resources)` returns only discrete resource-change events (`resourceChange`/`waste`/`maxResourceAmount`), less useful for a mana-over-time read.
  - `events(fightIDs, dataType, limit, sourceID?, abilityID?, startTime?, endTime?, includeResources?)` → `ReportEventPaginator { data, nextPageTimestamp }`. `dataType`: EventDataType — verified to include `Casts`, `DamageDone`, `Healing`, `CombatantInfo`, **`Resources`** (full enum: All/Buffs/Casts/CombatantInfo/DamageDone/DamageTaken/Deaths/Debuffs/Dispels/Healing/Interrupts/Resources/Summons/Threat). `includeResources:Boolean` rides a resource snapshot on other event types (mana = resource type 0). Used for the healer MANA lever.
  - `fights(fightIDs) { startTime, endTime }` → `[ReportFight]` (also has `kill`, `difficulty`, `size`).
    - **`phaseTransitions { id startTime }`** on `ReportFight` (verified live 2026-06): each
      entry is a phase BOUNDARY — `id` the phase number (1-based; id 1 is at fight start),
      `startTime` the absolute ms it begins. `null` for a single-phase fight. `core.dpsOverTime`
      returns the boundaries as fraction-of-fight so the graph card can ALIGN phases across
      kills (a faster phase ends at a different fight-% each kill, so raw fight-% smears it).
  - **`graph(fightIDs, sourceID, dataType, viewBy, startTime, endTime)`** → JSON (verified
    live 2026-06). `dataType` is TableDataType (`DamageDone`/`Healing`/…). Returns
    `{ data: { series: [{ name, guid, type, pointStart, pointInterval, total, data:[…] }] } }`.
    With `viewBy:Source` + a `sourceID` filter the series are the actor, one per pet, and a
    `"Total"` (actor+pets) series. `data[i]` is the ROLLING throughput (DPS/HPS) at
    `pointStart + i*pointInterval` — a RATE, not per-bin damage (mean(data) ≈ total/dur).
    MUST pass `startTime`/`endTime` = the fight window or it bins the WHOLE report (mostly
    zero pre-pull). `core.dpsOverTime` (the DPS-over-time card). One cheap binned request
    instead of paginating every damage event.
  - `fights { … }` with NO `fightIDs` → ALL pulls in the report (the progression
    flow's backbone). Verified-present `ReportFight` fields (live, 2026-06):
    `id, name, kill, fightPercentage, bossPercentage, lastPhase, encounterID,
    friendlyPlayers ([Int] actor ids), averageItemLevel, difficulty, size,
    startTime, endTime`. `fightPercentage`/`bossPercentage` are boss health
    REMAINING (0 = kill); `lastPhase` is the phase reached.
  - `events(fightIDs:[Int], dataType:Deaths, limit:10000)` → death events across
    MANY pulls in one request; each row carries `fight` so you bucket per-pull.
    Verified Death-event fields: `timestamp, type, sourceID, targetID,
    abilityGameID, fight, killerID, killingAbilityGameID` (killing blow = last).
  - `masterData { actors { id, name, server, type, subType } }` → `[ReportActor]`.
    For a Player, `subType` is the CLASS (e.g. "Paladin"); `id` matches event
    `targetID`/`sourceID`.
- `characterData.character(...).recentReports(limit) { data { code startTime title zone { name } } }`
  → recent raid nights (the progression picker; works on the client/CLI token too).
- `worldData.encounter(id).characterRankings(difficulty, metric, page)` with NO
  className/specName → top parses across all specs; their `duration` (ms) is the
  field KILL time (the DPS-check reference — no hard-coded enrage).
- `userData.currentUser.characters` → `[Character]` (user API + view-user-profile scope).
- `rateLimitData { pointsResetIn }` (also `limitPerHour`, `pointsSpentThisHour`).

## Field-shape gotchas (the ones that bit us / could)
- **`ReportActor.server` is a `String`** (the realm name). The `{id,name,slug,region}`
  OBJECT is the separate **`Server`** type used by `Character.server` and ranking
  entries — don't conflate them. (`actors` also accepts a `type`/`subType` arg,
  e.g. `actors(type:"Player")`, so server-side filtering is possible.)
- `Server.region` is a **`Region`** object → use `.region.slug` / `.region.compactName` ("US"/"EU"), not a string.
- `fightIDs: [Int]` is a list, but a single `fightIDs: 123` is coerced to `[123]`.
- `events.abilityID` is `Float`; `table`/`events` `dataType` are *different* enums
  (TableDataType vs EventDataType) — a value valid for one may not be for the other.

## Known NON-schema issue to verify
- Raid difficulty IDs are **data, not schema**, so the docs can't confirm them.
  `core.DIFFICULTY` maps `2:LFR,3:Normal,4:Heroic,5:Mythic`, but `wcl.myCharacters`
  queries `difficulty:1` for LFR — these disagree. Mythic/Heroic/Normal (5/4/3)
  are consistent and correct; only LFR is in question (low impact — not the tool's
  audience). Confirm the real LFR id against a live LFR-only character before relying on it.
