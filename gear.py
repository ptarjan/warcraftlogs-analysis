#!/usr/bin/env python3
"""Automatic gear audit: reads each item's real secondary stats (Wowhead
tooltip API, cached locally) and compares your gear slot-by-slot against what
the top-DPS field actually wears.

Why this exists: Warcraft Logs only gives item IDs, not stats. And "what the
highest-crit players wear in a slot" is misleading (they may get crit
elsewhere). So this reads ACTUAL stats and flags pieces itemized away from
your target stat, while confirming which slots already match the field.

Usage:
    python gear.py "Hadryan" proudmoore US --priority crit
"""
import argparse
import json
import os
import re
import time
import urllib.request
from collections import Counter

from analyze import player_metrics, top_rankings, character_zone, character_encounter

TOOLTIP = "https://nether.wowhead.com/tooltip/item/%d"
CACHE = os.path.join(os.path.dirname(__file__), ".item_cache.json")
SLOT = {0: "Head", 1: "Neck", 2: "Shoulder", 4: "Chest", 5: "Belt", 6: "Legs",
        7: "Feet", 8: "Wrist", 9: "Hands", 10: "Ring1", 11: "Ring2",
        12: "Trinket1", 13: "Trinket2", 14: "Back", 15: "Weapon"}
STATS = ("Critical Strike", "Haste", "Mastery", "Versatility")
SHORT = {"Critical Strike": "crit", "Haste": "haste", "Mastery": "mastery",
         "Versatility": "vers"}

_cache = {}


def _load_cache():
    global _cache
    if os.path.exists(CACHE):
        try:
            _cache = json.load(open(CACHE))
        except Exception:
            _cache = {}


def _save_cache():
    try:
        json.dump(_cache, open(CACHE, "w"))
    except Exception:
        pass


def item_stats(item_id):
    """Return {name, ilvl, crit, haste, mastery, vers, crafted} for an item id.

    Cached on disk so repeat runs are instant and we're polite to Wowhead.
    """
    key = str(item_id)
    if key in _cache:
        return _cache[key]
    try:
        req = urllib.request.Request(TOOLTIP % item_id,
                                     headers={"User-Agent": "Mozilla/5.0"})
        d = json.load(urllib.request.urlopen(req, timeout=30))
        html = d.get("tooltip", "")
        out = {"name": d.get("name", str(item_id)), "crit": 0, "haste": 0,
               "mastery": 0, "vers": 0}
        m = re.search(r"<!--ilvl-->(\d+)", html)
        out["ilvl"] = int(m.group(1)) if m else None
        for amt, stat in re.findall(r"(\d+)\s+(Critical Strike|Haste|Mastery|Versatility)", html):
            out[SHORT[stat]] += int(amt)
        out["crafted"] = ("Random" in html or "crafted" in html.lower())
        time.sleep(0.1)
    except Exception:
        out = {"name": str(item_id), "crit": 0, "haste": 0, "mastery": 0,
               "vers": 0, "ilvl": None, "crafted": False}
    _cache[key] = out
    _save_cache()
    return out


def your_gear(name, server, region, difficulty):
    """Gear from your highest-ilvl kill (= current)."""
    # find highest-ilvl killed boss
    c = character_zone(name, server, region, difficulty)
    ranks = [r for r in c["zoneRankings"].get("rankings", [])
             if r.get("totalKills", 0) > 0]
    best = None
    for r in ranks:
        er = character_encounter(name, server, region, r["encounter"]["id"], difficulty)
        if er and er.get("ranks"):
            bk = max(er["ranks"], key=lambda x: x.get("bracketData") or 0)
            il = bk.get("bracketData") or 0
            if not best or il > best[0]:
                best = (il, bk["report"]["code"], bk["report"]["fightID"])
    if not best:
        return None
    return player_metrics(best[1], best[2], name, None, "Monk")


def field_consensus(class_name, spec_name, difficulty, encounters, n=40):
    """Most-worn item per slot among top-DPS players, across several bosses."""
    per_slot = {}
    seen = set()
    got = 0
    for eid in encounters:
        if got >= n:
            break
        for page in (1, 2):
            for r in top_rankings(eid, difficulty, class_name, spec_name, page):
                key = (r["name"], r.get("server", {}).get("name"))
                if key in seen:
                    continue
                seen.add(key)
                try:
                    m = player_metrics(r["report"]["code"], r["report"]["fightID"],
                                       r["name"], spec_name, class_name)
                except Exception:
                    continue
                if not m:
                    continue
                got += 1
                for g in m["gear"]:
                    if g.get("slot") in SLOT and g.get("name"):
                        per_slot.setdefault(g["slot"], Counter())[g["id"]] += 1
                if got >= n:
                    break
            if got >= n:
                break
    return per_slot, got


def gear_findings(name, server, region, difficulty, class_name, spec_name, priority):
    """Return (rows, swaps, crafted_slots) reading real item stats.

    rows: per-slot display tuples. swaps: slots where you have 0 of `priority`
    and the field's item has it. crafted_slots: slots you can stat-select.
    """
    _load_cache()
    you = your_gear(name, server, region, difficulty)
    if not you:
        return None
    ymap = {g["slot"]: g for g in you["gear"]}
    enc = [3176, 3177, 3179, 3181, 3306]
    consensus, npl = field_consensus(class_name, spec_name, difficulty, enc)
    rows, swaps, crafted_slots = [], [], []
    for s in sorted(SLOT):
        if s not in ymap:
            continue
        g = ymap[s]
        ist = item_stats(g["id"])
        top_id = consensus.get(s, Counter()).most_common(1)
        top_id = top_id[0][0] if top_id else None
        match = ("== field" if top_id == g["id"]
                 else (f"field: {item_stats(top_id)['name'][:22]}" if top_id else "?"))
        rows.append((SLOT[s], ist, match, ist.get("crafted")))
        if ist.get("crafted"):
            crafted_slots.append(SLOT[s])
        if ist.get(priority, 0) == 0 and top_id and top_id != g["id"]:
            alt = item_stats(top_id)
            if alt.get(priority, 0) > 0:
                swaps.append((SLOT[s], ist["name"], alt["name"], alt[priority]))
    return {"rows": rows, "swaps": swaps, "crafted_slots": crafted_slots,
            "n": npl, "priority": priority}


def audit(name, server, region, difficulty, class_name, spec_name, priority):
    f = gear_findings(name, server, region, difficulty, class_name, spec_name, priority)
    if not f:
        raise SystemExit("No gear found.")
    print(f"\n=== Gear audit for {name} (priority: {priority}) | vs {f['n']} top-DPS "
          f"{spec_name}s ===")
    print(f"{'SLOT':9} {'YOUR ITEM':30} {'crit/hst/mas/ver':17} {'matches field?'}")
    for slot, ist, match, crafted in f["rows"]:
        secs = f"{ist['crit']:>3}/{ist['haste']:>3}/{ist['mastery']:>3}/{ist['vers']:>3}"
        print(f"{slot:9} {ist['name'][:30]:30} {secs:17} {match}"
              f"{' [crafted]' if crafted else ''}")
    print(f"\nLegend: crit/haste/mastery/vers. '[crafted]' = you choose the stats "
          f"-> set to {priority}.")
    if f["swaps"]:
        print(f"\nPieces with ZERO {priority} where the field's item has it:")
        for slot, mine, theirs, amt in f["swaps"]:
            print(f"  {slot}: '{mine}' -> '{theirs}' (+{amt} {priority})")
    else:
        print(f"\nNo clear {priority} upgrade from drops -- your items match the field. "
              f"Gains: set crafted slots ({', '.join(f['crafted_slots']) or 'none'}) to "
              f"{priority}; sim the rest (Droptimizer).")


def main():
    ap = argparse.ArgumentParser(description="Automatic gear audit vs the field")
    ap.add_argument("name"); ap.add_argument("server"); ap.add_argument("region")
    ap.add_argument("--class", dest="class_name", default="Monk")
    ap.add_argument("--spec", dest="spec_name", default="Brewmaster")
    ap.add_argument("--difficulty", type=int, default=5)
    ap.add_argument("--priority", default="crit", choices=list(SHORT.values()))
    args = ap.parse_args()
    audit(args.name, args.server, args.region, args.difficulty,
          args.class_name, args.spec_name, args.priority)


if __name__ == "__main__":
    main()
