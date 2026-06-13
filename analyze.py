#!/usr/bin/env python3
"""Warcraft Logs character DPS analysis.

Compares a character's parses against the field with proper controls -- item
level, kill duration, population -- so the conclusions survive scrutiny. Built
from a deep-dive that learned the hard way which comparisons are misleading:

  * Buff/consumable names vary ("Hearty Well Fed" vs "Well Fed") -> match by
    keyword, never exact string.
  * Ranking percentiles are KILLS ONLY and are population-relative; Heroic vs
    Mythic is not apples-to-apples. Control for difficulty.
  * A character's ranked kills are logged at the item level AT THE TIME, often
    mid-progression -> use the highest-ilvl / most recent kill for "current"
    gear, and compare against ilvl-matched peers.
  * Compare per-cast damage and casts/min, not just totals; control for kill
    duration before blaming execution.
  * Secondary stats live in CombatantInfo events (keyed by sourceID), not in
    playerDetails (often empty).

Usage:
    python analyze.py "Hadryan" proudmoore US --class Monk --spec Brewmaster
    python analyze.py "Name" server US --difficulty 4   # Heroic
"""
import argparse
import statistics as st
from collections import Counter

from wcl import gql, PrivateReport

# WoW difficulty ids used by Warcraft Logs rankings.
DIFFICULTY = {2: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic"}

# Item slots that the field actually enchants (verify each season -- e.g. wrist
# and back were enchanted by 0% of players one season). Used only for display.
ENCHANTABLE_SLOTS = {0: "Head", 4: "Chest", 6: "Legs", 7: "Feet",
                     8: "Wrist", 10: "Ring1", 11: "Ring2", 14: "Back",
                     15: "Weapon"}


# --------------------------------------------------------------------------- #
# Low-level fetchers
# --------------------------------------------------------------------------- #
def character_zone(name, server, region, difficulty):
    """Return the character's zoneRankings for the current zone + difficulty."""
    q = '''query { characterData { character(
        name:"%s", serverSlug:"%s", serverRegion:"%s") {
        id classID zoneRankings(difficulty:%d) } } }''' % (
        name, server.lower().replace(" ", "-"), region, difficulty)
    c = gql(q)["characterData"]["character"]
    if not c:
        raise SystemExit(f"Character not found: {name}-{server}-{region}")
    return c


def character_encounter(name, server, region, encounter_id, difficulty):
    """Per-encounter ranks for a character (each ranked KILL, with ilvl/date)."""
    q = '''query { characterData { character(
        name:"%s", serverSlug:"%s", serverRegion:"%s") {
        encounterRankings(encounterID:%d, difficulty:%d, metric:dps) } } }''' % (
        name, server.lower().replace(" ", "-"), region, encounter_id, difficulty)
    c = gql(q)["characterData"]["character"]
    return c["encounterRankings"] if c else None


def top_rankings(encounter_id, difficulty, class_name, spec_name, page=1):
    q = '''query { worldData { encounter(id:%d) { characterRankings(
        difficulty:%d, className:"%s", specName:"%s", metric:dps, page:%d) } } }''' % (
        encounter_id, difficulty, class_name, spec_name, page)
    cr = gql(q)["worldData"]["encounter"]["characterRankings"]
    return cr.get("rankings", []) if isinstance(cr, dict) else []


def _entry(table_data, name, spec_name):
    entries = table_data.get("entries", [])
    hit = [e for e in entries if e["name"] == name]
    if not hit:
        hit = [e for e in entries if spec_name in str(e.get("icon", ""))]
    return hit[0] if hit else None


def player_metrics(code, fight, name, spec_name, class_name="Monk"):
    """Damage + cast metrics for one player on one fight."""
    q = '''query { reportData { report(code:"%s") {
        dmg: table(fightIDs:%d, dataType:DamageDone, sourceClass:"%s")
        casts: table(fightIDs:%d, dataType:Casts, sourceClass:"%s") } } }''' % (
        code, fight, class_name, fight, class_name)
    d = gql(q)["reportData"]["report"]
    dmg, casts = d["dmg"]["data"], d["casts"]["data"]
    dur = dmg["totalTime"] / 1000.0
    e = _entry(dmg, name, spec_name)
    if not e:
        return None
    ce = _entry(casts, e["name"], spec_name)
    cast_counts = {a["name"]: a["total"] for a in (ce["abilities"] if ce else [])}
    dmg_by = {a["name"]: a["total"] for a in e["abilities"]}
    return {
        "name": e["name"], "ilvl": e.get("itemLevel"), "dur": dur,
        "dps": e["total"] / dur, "total": e["total"],
        "active_pct": 100 * e.get("activeTime", 0) / dmg["totalTime"] if dmg["totalTime"] else 0,
        "targets": len(e.get("targets", [])),
        "casts": cast_counts, "dmg_by": dmg_by,
        "casts_per_min": sum(cast_counts.values()) / (dur / 60) if dur else 0,
        "sourceID": e["id"], "gear": e.get("gear", []),
    }


def buff_uptimes(code, fight, source_id):
    """Self-buff uptime % keyed by buff name (use keyword matching to compare)."""
    q = '''query { reportData { report(code:"%s") {
        table(fightIDs:%d, dataType:Buffs, sourceID:%d) } } }''' % (
        code, fight, source_id)
    d = gql(q)["reportData"]["report"]["table"]["data"]
    tt = d["totalTime"]
    return {a["name"]: 100 * a.get("totalUptime", 0) / tt for a in d["auras"] if tt}


def secondary_stats(code, fight, source_id):
    """Crit/haste/mastery/vers ratings from CombatantInfo events."""
    q = '''query { reportData { report(code:"%s") { events(
        fightIDs:%d, dataType:CombatantInfo, limit:50) { data } } } }''' % (code, fight)
    for e in gql(q)["reportData"]["report"]["events"]["data"]:
        if e.get("sourceID") == source_id:
            return {
                "agi": e.get("agility", 0), "stam": e.get("stamina", 0),
                "crit": e.get("critMelee", 0), "haste": e.get("hasteMelee", 0),
                "mastery": e.get("mastery", 0), "vers": e.get("versatilityDamageDone", 0),
            }
    return None


def gear_summary(gear, tier_set_id=None):
    enchanted = {ENCHANTABLE_SLOTS[g["slot"]] for g in gear
                 if g.get("slot") in ENCHANTABLE_SLOTS and g.get("permanentEnchant")}
    missing = {ENCHANTABLE_SLOTS[s] for s in ENCHANTABLE_SLOTS} - enchanted
    trinkets = [g["name"] for g in gear if g.get("slot") in (12, 13)]
    tier = sum(1 for g in gear if tier_set_id and g.get("setID") == tier_set_id)
    return {"enchanted": enchanted, "missing": missing, "trinkets": trinkets, "tier": tier}


# --------------------------------------------------------------------------- #
# Analyses
# --------------------------------------------------------------------------- #
def overview(name, server, region, difficulty):
    c = character_zone(name, server, region, difficulty)
    zr = c["zoneRankings"]
    print(f"\n=== {name}-{server} ({region}) | {DIFFICULTY.get(difficulty, difficulty)} | zone {zr.get('zone')} ===")
    print(f"Best-avg %ile: {zr.get('bestPerformanceAverage'):.1f}   "
          f"Median %ile: {zr.get('medianPerformanceAverage'):.1f}")
    killed = []
    for r in zr.get("rankings", []):
        if r.get("totalKills", 0) > 0 and r.get("rankPercent") is not None:
            killed.append(r)
            print(f"  {r['encounter']['name'][:28]:28} {r['rankPercent']:5.1f}%ile  "
                  f"({r['totalKills']} kills)")
    return zr, killed


def collect_ilvl_peers(encounter_id, difficulty, class_name, spec_name,
                       target_ilvl, n=12, ilvl_window=2, pages=6):
    """Peers within +/- ilvl_window of target_ilvl, with full metrics."""
    peers = []
    for page in range(1, pages + 1):
        if len(peers) >= n:
            break
        for r in top_rankings(encounter_id, difficulty, class_name, spec_name, page):
            if len(peers) >= n:
                break
            il = r.get("bracketData")
            if not (il and abs(il - target_ilvl) <= ilvl_window):
                continue
            try:
                m = player_metrics(r["report"]["code"], r["report"]["fightID"],
                                   r["name"], spec_name, class_name)
            except PrivateReport:
                continue
            except Exception:
                continue
            if m:
                m["rank_dur"] = r.get("duration", 0) / 1000
                peers.append(m)
    return peers


def deep_compare(name, server, region, encounter, difficulty, class_name, spec_name):
    """Full controlled comparison for one encounter (uses the best-ilvl kill)."""
    er = character_encounter(name, server, region, encounter["id"], difficulty)
    if not er or not er.get("ranks"):
        return
    # Best-ilvl kill = closest to current gear.
    best = max(er["ranks"], key=lambda r: r.get("bracketData") or 0)
    code, fight, ilvl = best["report"]["code"], best["report"]["fightID"], best.get("bracketData")
    you = player_metrics(code, fight, name, spec_name, class_name)
    if not you:
        return
    print(f"\n--- {encounter['name']} | your best-ilvl kill: ilvl {ilvl}, "
          f"{you['dur']:.0f}s, {you['dps']:,.0f} dps, {best['rankPercent']:.0f}%ile ---")

    peers = collect_ilvl_peers(encounter["id"], difficulty, class_name, spec_name,
                               ilvl or 0)
    if not peers:
        print("  (no item-level-matched peers found)")
        return

    def pmed(key):
        v = [p[key] for p in peers if p.get(key) is not None]
        return st.median(v) if v else float("nan")

    print(f"  vs {len(peers)} ilvl-matched peers:")
    print(f"    DPS:          you {you['dps']:>9,.0f}   peer med {pmed('dps'):>9,.0f}")
    print(f"    casts/min:    you {you['casts_per_min']:>9.1f}   peer med {pmed('casts_per_min'):>9.1f}")
    print(f"    active %:     you {you['active_pct']:>9.1f}   peer med {pmed('active_pct'):>9.1f}")
    print(f"    targets hit:  you {you['targets']:>9}   peer med {pmed('targets'):>9.1f}")

    # Duration-controlled DPS (peers killing in a similar time as you).
    near = [p["dps"] for p in peers if abs(p["dur"] - you["dur"]) <= 40]
    if near:
        print(f"    DPS at your kill-time (+/-40s): you {you['dps']:,.0f}  "
              f"vs peer med {st.median(near):,.0f}  (n={len(near)})")

    # Secondary stat allocation (yours; peers' stats need per-report fight ids).
    you_stats = secondary_stats(code, fight, you["sourceID"])
    if you_stats:
        sec = sum(you_stats[k] for k in ("crit", "haste", "mastery", "vers")) or 1
        print("    secondary allocation (you): " + "  ".join(
            f"{k} {100*you_stats[k]/sec:.0f}%" for k in ("crit", "haste", "mastery", "vers")))

    # Gear (current = best-ilvl kill).
    g = gear_summary(you["gear"])
    print(f"    enchants missing: {sorted(g['missing']) or 'none of the meta slots'}")
    print(f"    trinkets: {g['trinkets']}")
    peer_trinkets = Counter(t for p in peers for t in gear_summary(p['gear'])['trinkets'])
    print(f"    peer trinkets: {[t for t,_ in peer_trinkets.most_common(4)]}")


def difficulty_inflation(name, server, region, encounter, class_name, spec_name,
                         high=5, low=4, sample=12):
    """Quantify how much higher people parse on `low` vs `high` difficulty.

    Answers "are easier-difficulty percentiles just inflated?" by sampling
    players and comparing their own percentile on both difficulties.
    """
    print(f"\n=== Difficulty inflation check on {encounter['name']} "
          f"({DIFFICULTY[low]} vs {DIFFICULTY[high]}) ===")
    rows = []
    seen = set()
    for page in (1, 5, 12, 25):
        if len([r for r in rows]) >= sample:
            break
        for r in top_rankings(encounter["id"], high, class_name, spec_name, page):
            srv = r.get("server", {})
            if srv.get("region") != region:
                continue
            key = (r["name"], srv.get("name"))
            if key in seen:
                continue
            seen.add(key)
            try:
                eh = character_encounter(r["name"], srv.get("name", ""), region, encounter["id"], low)
                em = character_encounter(r["name"], srv.get("name", ""), region, encounter["id"], high)
            except Exception:
                continue
            ph = eh["ranks"][0]["rankPercent"] if eh and eh.get("ranks") else None
            pm = em["ranks"][0]["rankPercent"] if em and em.get("ranks") else None
            if ph is not None and pm is not None:
                rows.append((r["name"], pm, ph, ph - pm))
            if len(rows) >= sample:
                break
    if rows:
        print(f"  median {DIFFICULTY[high]} %ile: {st.median([r[1] for r in rows]):.0f}   "
              f"median {DIFFICULTY[low]} %ile: {st.median([r[2] for r in rows]):.0f}   "
              f"median inflation: {st.median([r[3] for r in rows]):+.0f} pts")


# --------------------------------------------------------------------------- #
def run(name, server, region, class_name="Monk", spec_name="Brewmaster",
        difficulty=5, bosses=3, inflation=False):
    """Overview + controlled per-boss comparison (the CLI/web entry point)."""
    zr, killed = overview(name, server, region, difficulty)
    for r in killed[:bosses]:
        try:
            deep_compare(name, server, region, r["encounter"],
                         difficulty, class_name, spec_name)
        except Exception as e:  # noqa: BLE001
            print(f"  ({r['encounter']['name']}: {e})")
    if inflation and killed:
        difficulty_inflation(name, server, region,
                             killed[0]["encounter"], class_name, spec_name)


def main():
    ap = argparse.ArgumentParser(description="Warcraft Logs character DPS analysis")
    ap.add_argument("name")
    ap.add_argument("server")
    ap.add_argument("region", help="US / EU / KR / TW / CN")
    ap.add_argument("--class", dest="class_name", default="Monk")
    ap.add_argument("--spec", dest="spec_name", default="Brewmaster")
    ap.add_argument("--difficulty", type=int, default=5, help="5=Mythic 4=Heroic")
    ap.add_argument("--bosses", type=int, default=3,
                    help="how many killed bosses to deep-compare")
    ap.add_argument("--inflation", action="store_true",
                    help="also run the Heroic-vs-Mythic inflation check")
    args = ap.parse_args()
    run(args.name, args.server, args.region, args.class_name, args.spec_name,
        args.difficulty, args.bosses, args.inflation)


if __name__ == "__main__":
    main()
