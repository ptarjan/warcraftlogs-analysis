#!/usr/bin/env python3
"""Generate a concrete, prioritized prescription for a character.

Pops out an actionable to-do list -- exact enchants, trinket swaps, consumable
changes, stat adjustments, and the execution habits to fix -- each derived from
what the item-level-matched field actually does, aggregated across ALL of the
character's kills and normalized against peers on the same fights (so
intermissions / forced downtime don't masquerade as mistakes).

Usage:
    python prescribe.py "Hadryan" proudmoore US --class Monk --spec Brewmaster
"""
import argparse
import statistics as st
from collections import Counter, defaultdict

from wcl import PrivateReport
from analyze import (character_zone, character_encounter, player_metrics,
                     top_rankings, secondary_stats, buff_uptimes, ENCHANTABLE_SLOTS)
from diagnose import compare_boss
from gear import gear_findings

SLOT_NAME = ENCHANTABLE_SLOTS


def best_ilvl_kill(name, server, region, encounter_id, difficulty):
    er = character_encounter(name, server, region, encounter_id, difficulty)
    if not er or not er.get("ranks"):
        return None
    best = max(er["ranks"], key=lambda r: r.get("bracketData") or 0)
    return best["report"]["code"], best["report"]["fightID"], best.get("bracketData")


def field_gear_consumables(encounter_id, difficulty, class_name, spec_name,
                           target_ilvl, n=10):
    ench_by_slot = defaultdict(Counter)
    trinkets, flasks, foods = Counter(), Counter(), Counter()
    crit_pcts = []
    got = 0
    for page in range(1, 8):
        if got >= n:
            break
        for r in top_rankings(encounter_id, difficulty, class_name, spec_name, page):
            if got >= n:
                break
            il = r.get("bracketData")
            if not (il and abs(il - target_ilvl) <= 2):
                continue
            code, fight = r["report"]["code"], r["report"]["fightID"]
            try:
                m = player_metrics(code, fight, r["name"], spec_name, class_name)
                if not m:
                    continue
                for g in m["gear"]:
                    s = g.get("slot")
                    if s in SLOT_NAME and g.get("permanentEnchantName"):
                        ench_by_slot[SLOT_NAME[s]][g["permanentEnchantName"]] += 1
                    if s in (12, 13) and g.get("name"):
                        trinkets[g["name"]] += 1
                bf = buff_uptimes(code, fight, m["sourceID"])
                for nm, up in bf.items():
                    if up > 50 and "flask" in nm.lower():
                        flasks[nm] += 1
                    if up > 50 and "well fed" in nm.lower():
                        foods[nm] += 1
                s = secondary_stats(code, fight, m["sourceID"])
                if s:
                    sec = sum(s[k] for k in ("crit", "haste", "mastery", "vers")) or 1
                    crit_pcts.append(100 * s["crit"] / sec)
                got += 1
            except PrivateReport:
                continue
            except Exception:
                continue
    return {"ench_by_slot": ench_by_slot, "trinkets": trinkets, "flasks": flasks,
            "foods": foods, "crit_pct": st.median(crit_pcts) if crit_pcts else None,
            "n": got}


def my_setup(code, fight, source_id, gear):
    bf = buff_uptimes(code, fight, source_id)
    flask = next((n for n, u in bf.items() if "flask" in n.lower() and u > 50), None)
    food = next((n for n, u in bf.items() if "well fed" in n.lower() and u > 50), None)
    stats = secondary_stats(code, fight, source_id)
    crit = (100 * stats["crit"] / (sum(stats[k] for k in ("crit", "haste", "mastery", "vers")) or 1)
            if stats else None)
    trinkets = [g["name"] for g in gear if g.get("slot") in (12, 13)]
    ench = {SLOT_NAME[g["slot"]] for g in gear
            if g.get("slot") in SLOT_NAME and g.get("permanentEnchant")}
    return flask, food, crit, trinkets, ench


def aggregate_execution(name, server, region, difficulty, class_name, spec_name, bosses):
    """Peer-normalized execution excess, aggregated across all killed bosses."""
    per_boss = []
    for r in bosses:
        try:
            c = compare_boss(name, server, region, r["encounter"], difficulty,
                             class_name, spec_name)
        except Exception:
            c = None
        if c:
            per_boss.append(c)
    if not per_boss:
        return None
    def med(key):
        return st.median([c["you"][key] - c["peer"][key] for c in per_boss])
    # Bosses where range is the standout problem.
    range_bosses = sorted(
        [(c["you"]["range_lost_per_min"] - c["peer"]["range_lost_per_min"], c["boss"])
         for c in per_boss], reverse=True)
    return {
        "n_bosses": len(per_boss),
        "press_excess": med("press_lost_per_min"),
        "range_excess": med("range_lost_per_min"),
        "total_excess": med("lost_per_min"),
        "overshoot_excess": med("overshoot_ms"),
        "worst_range": [b for d, b in range_bosses if d > 1.5],
    }


def run(name, server, region, class_name="Monk", spec_name="Brewmaster",
        difficulty=5):
    """Generate the prioritized prescription (the CLI/web entry point)."""
    N, S, R = name, server, region
    CL, SP, D = class_name, spec_name, difficulty

    c = character_zone(N, S, R, D)
    ranks = [r for r in c["zoneRankings"].get("rankings", [])
             if r.get("totalKills", 0) > 0 and r.get("rankPercent") is not None]
    if not ranks:
        raise SystemExit("No kills found.")

    # Highest-ilvl kill = current gear, for the gear/consumable prescription.
    enc_best = []
    for r in ranks:
        bk = best_ilvl_kill(N, S, R, r["encounter"]["id"], D)
        if bk:
            enc_best.append((bk[2] or 0, r, bk))
    enc_best.sort(key=lambda x: x[0], reverse=True)
    cur_ilvl, gear_boss, (code, fight, ilvl) = enc_best[0]
    you = player_metrics(code, fight, N, SP, CL)
    my_flask, my_food, my_crit, my_trinkets, my_ench = my_setup(code, fight, you["sourceID"], you["gear"])

    print(f"\n{'='*66}\nPRESCRIPTION for {N}-{S} ({SP} {CL}) | current ilvl ~{cur_ilvl}")
    print(f"Aggregated across {len(ranks)} killed bosses; gear from your "
          f"{gear_boss['encounter']['name']} kill; execution normalized vs peers.\n{'='*66}")

    field = field_gear_consumables(gear_boss["encounter"]["id"], D, CL, SP, cur_ilvl)
    execd = aggregate_execution(N, S, R, D, CL, SP, ranks)

    rx = []  # (sort_key, impact, text)

    # --- Execution (peer-normalized, aggregated) ---
    if execd:
        # ~lost seconds/min as % of a ~per-minute cast budget (~50 GCDs/min ~ 1s each)
        if execd["press_excess"] >= 1.0:
            pct = execd["press_excess"] / 60 * 100
            rx.append((-execd["press_excess"], f"~{pct:.0f}% DPS",
                f"PRESS FASTER (every boss): you idle ~{execd['press_excess']:.1f}s/min MORE than "
                f"peers while IN melee range -- not latency (yours matches theirs), just gaps "
                f"between GCDs. Always queue your next ability so a GCD never sits empty."))
        if execd["range_excess"] >= 1.0 or execd["worst_range"]:
            where = (" Worst on: " + ", ".join(execd["worst_range"]) + ".") if execd["worst_range"] else ""
            pct = max(execd["range_excess"], 0.1) / 60 * 100
            rx.append((-execd["range_excess"], f"~{pct:.0f}% DPS",
                f"UPTIME on specific fights: you're out of melee ~{execd['range_excess']:.1f}s/min "
                f"more than peers (intermissions excluded).{where} Pre-position and use mobility "
                f"(Roll / Tiger's Lust) to stay on the boss through mechanics."))

    # --- Consumables ---
    if field["flasks"]:
        tf = field["flasks"].most_common(1)[0][0]
        if my_flask and my_flask != tf:
            rx.append((-2.5, "~2% DPS", f"FLASK: {my_flask} -> {tf} "
                       f"({field['flasks'][tf]}/{field['n']} peers)."))
    if field["foods"]:
        tfo = field["foods"].most_common(1)[0][0]
        if my_food and my_food != tfo:
            rx.append((-1.0, "~1% DPS", f"FOOD: {my_food} -> {tfo}."))

    # --- Gear + crit: every crit recommendation must come with a concrete HOW ---
    priority = "crit"
    gf = gear_findings(N, S, R, D, CL, SP, priority)
    crit_gap = (field["crit_pct"] - my_crit) if (my_crit is not None and field["crit_pct"]) else 0
    how_to_crit = False
    if gf:
        # Concrete ways to gain crit (these ARE the "how"):
        for slot, mine, theirs, amt, cnt, tot in gf["swaps"]:
            how_to_crit = True
            rx.append((-2.0, "~1-3% DPS", f"CRIT via {slot}: replace '{mine}' with "
                       f"'{theirs}' (+{amt} {priority}; {cnt}/{tot} of the field runs it)."))
        for slot, name, mine, best in gf["restats"]:
            how_to_crit = True
            rx.append((-1.5, "~1-2% DPS", f"CRIT via {slot}: '{name}' is selectable -- recraft "
                       f"to {best} {priority} (you have {mine})."))
        emb = gf["embellished_slots"]
        if len(emb) < 2:
            rx.append((-2.5, "~2-4% DPS", f"EMBELLISHMENTS: you run {len(emb)}/2 -- fill the "
                       f"free slot (throughput you can't get from drops)."))
        tf = gf.get("tier_flex")
        if tf:
            how_to_crit = True
            rx.append((-1.5, "~1-2% DPS", f"TIER FLEX: your {tf['slot']} ('{tf['item']}', ilvl "
                       f"{tf['ilvl']}) is a crafted non-embellished flex piece -- wear TIER "
                       f"{tf['slot']} and flex a different tier slot to a crit drop (keeps 4pc, "
                       f"+ilvl, +crit). Sim the combo."))
    # Only mention the crit gap if we can't act on it -- and say WHY, not "raise crit".
    if crit_gap >= 4 and not how_to_crit:
        rx.append((0.0, "info", f"CRIT: yours ({my_crit:.0f}%) is below the field "
                   f"({field['crit_pct']:.0f}%), but NOT actionable now -- every item you own is "
                   f"already crit-maxed and no crit-itemized upgrade exists to swap to. It only "
                   f"rises when crit-itemized drops come (watch belt/boots)."))
    elif gf and not gf["swaps"] and not gf["restats"] and crit_gap < 4:
        rx.append((0.0, "info", "GEAR/STATS: optimal for what you own -- no lever; gains are "
                   "future drops + a sim (Droptimizer)."))

    print("\nDO THESE IN ORDER (biggest DPS first):")
    if not rx:
        print("  You match the field on gear, consumables, stats, and execution. "
              "Remaining gains are farm kills + raid comp.")
    for i, (_, impact, text) in enumerate(sorted(rx), 1):
        print(f"  {i}. [{impact:>9}]  {text}")
    print()


def main():
    ap = argparse.ArgumentParser(description="Prescription generator")
    ap.add_argument("name"); ap.add_argument("server"); ap.add_argument("region")
    ap.add_argument("--class", dest="class_name", default="Monk")
    ap.add_argument("--spec", dest="spec_name", default="Brewmaster")
    ap.add_argument("--difficulty", type=int, default=5)
    args = ap.parse_args()
    run(args.name, args.server, args.region, args.class_name, args.spec_name,
        args.difficulty)


if __name__ == "__main__":
    main()
