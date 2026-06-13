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
  - `table(fightIDs, dataType, sourceID?, hostilityType?)` → JSON. `dataType`: TableDataType (`DamageDone`, `Casts`, `Buffs`, `Debuffs`). `hostilityType`: `Enemies`.
  - `events(fightIDs, dataType, limit, sourceID?, abilityID?, startTime?, endTime?)` → `ReportEventPaginator { data, nextPageTimestamp }`. `dataType`: EventDataType (`Casts`, `DamageDone`, `CombatantInfo`).
  - `fights(fightIDs) { startTime, endTime }` → `[ReportFight]` (also has `kill`, `difficulty`, `size`).
  - `masterData { actors { name, server, type } }` → `[ReportActor]`.
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
