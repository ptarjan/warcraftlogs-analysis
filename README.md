# warcraftlogs-analysis

Tooling to analyze a Warcraft Logs character's DPS against the field — with the
statistical controls that make the conclusions actually hold up. Built for
Brewmaster Monk but parameterized for any class/spec, and it auto-detects the
current raid tier so it keeps working next season.

## Setup

```bash
cp .env.example .env      # then paste your WCL client id + secret
python3 wcl.py            # smoke test: should print "OK - token acquired"
```

Create an API client at <https://www.warcraftlogs.com/api/clients/>. The
`.env` and the cached token are gitignored, so no secret ever lands in git.
No third-party dependencies — standard library only.

## Usage

```bash
# Full Mythic analysis (overview + per-boss ilvl-controlled comparison)
python3 analyze.py "Hadryan" proudmoore US --class Monk --spec Brewmaster

# Heroic instead of Mythic
python3 analyze.py "Hadryan" proudmoore US --difficulty 4

# Add the difficulty-inflation check (Heroic vs Mythic percentiles)
python3 analyze.py "Hadryan" proudmoore US --inflation
```

## What it checks (and why)

This grew out of a long investigation into "why am I not 99th percentile?"
Most obvious answers turned out to be wrong; these are the comparisons that
survived:

- **Overview** — per-boss kill percentiles for a difficulty. Remember:
  **percentiles are kills-only** and population-relative.
- **Item-level-matched comparison** — DPS, casts/min, active time, and targets
  vs peers at *your* item level, so gear level isn't a confound.
- **Duration control** — compares your DPS only to peers who killed in a
  similar time, so a long progression kill isn't mistaken for low output.
- **Secondary-stat allocation** — crit/haste/mastery/vers split (from
  `CombatantInfo` events) vs the field. A defensive lean (low crit, high vers)
  shows up here.
- **Gear** — enchant coverage and trinkets, read from your **highest-item-level
  kill** (≈ current gear), compared to what peers run.
- **Difficulty inflation** — samples players and compares their own Heroic vs
  Mythic percentile, quantifying how much an easier tier inflates the number.

## Lessons baked in (don't relearn these)

- Buff/consumable names vary by rank/tier (`"Hearty Well Fed"` vs `"Well Fed"`).
  **Match buffs by keyword, never exact string** — an exact-match diff once
  reported a 100%-uptime food as "0%".
- A character's ranked parses are logged at the **item level at the time** —
  usually mid-progression. Use the highest-ilvl / most recent kill for current
  gear, or you'll critique stale equipment.
- Heroic vs Mythic percentiles are **not** comparable; the pools differ. Run the
  inflation check before drawing conclusions across difficulties.
- The default ranking `metric: dps` is raw DPS; comp/buff differences (e.g. an
  Augmentation Evoker) still inflate top parses and aren't visible per-player.
- `playerDetails.combatantInfo` is often empty — secondary stats come from
  `events(dataType: CombatantInfo)`, keyed by `sourceID`.
- Verify "enchantable" slots each season — some (wrist, back) were enchanted by
  ~0% of the field in a given tier.

## Files

- `wcl.py` — OAuth + GraphQL client (token caching, retry, private-report skip).
- `analyze.py` — the analyses and CLI.
