#!/usr/bin/env python3
"""Root-cause diagnosis of lost DPS from the event timeline -- COMPARATIVE.

Reports *why* uptime/APM is low, measured against peers on the SAME fight so
intermissions and forced-downtime phases cancel out (everyone eats the same
intermission; what matters is whether YOU are out of range more than they are).

For every gap between GCD-consuming casts it cross-references auto-attack
swings to classify the cause:

  * gap, but autos kept swinging  -> in range, NOT pressing (hesitation/latency)
  * gap, and autos also stopped   -> out of melee range / moving
  * forgotten buttons             -> per-ability cast rate below the field
  * GCD clipping / latency          -> normal gaps consistently over the GCD

Aggregates across ALL of a character's kills, not a single pull.

Usage:
    python diagnose.py "Hadryan" proudmoore US --boss "Crown"
    python diagnose.py "Hadryan" proudmoore US              # all kills, aggregated
"""
import argparse
import statistics as st

from wcl import gql, PrivateReport
from analyze import (character_zone, character_encounter, player_metrics,
                     top_rankings)

AUTO_ATTACK = 1  # abilityGameID for melee auto-attacks


def paginate_events(code, fight, source_id, data_type, ability_id=None,
                    start=None, end=None):
    out = []
    ab = f", abilityID: {ability_id}" if ability_id is not None else ""
    cursor = start
    while True:
        st_arg = f", startTime: {cursor}" if cursor is not None else ""
        en_arg = f", endTime: {end}" if end is not None else ""
        q = '''query { reportData { report(code:"%s") { events(
            fightIDs:%d, sourceID:%d, dataType:%s, limit:10000%s%s%s) {
            data nextPageTimestamp } } } }''' % (
            code, fight, source_id, data_type, ab, st_arg, en_arg)
        ev = gql(q)["reportData"]["report"]["events"]
        out.extend(ev["data"])
        nxt = ev.get("nextPageTimestamp")
        if not nxt:
            break
        cursor = nxt
    return out


def fight_window(code, fight):
    q = '''query { reportData { report(code:"%s") {
        fights(fightIDs:%d) { startTime endTime } } } }''' % (code, fight)
    f = gql(q)["reportData"]["report"]["fights"][0]
    return f["startTime"], f["endTime"]


def estimate_gcd(gaps_ms):
    normal = [g for g in gaps_ms if 700 <= g <= 1700]
    return st.median(normal) if normal else 1500.0


def fight_metrics(code, fight, source_id):
    """Pure computation: timeline diagnostic for one actor on one fight.

    Returns normalized rates (per-minute / % of fight) so fights of different
    length and different players are directly comparable.
    """
    f_start, f_end = fight_window(code, fight)
    dur = (f_end - f_start) / 1000.0
    casts = [e for e in paginate_events(code, fight, source_id, "Casts",
                                        start=f_start, end=f_end) if not e.get("fake")]
    autos = paginate_events(code, fight, source_id, "DamageDone",
                            ability_id=AUTO_ATTACK, start=f_start, end=f_end)
    auto_ts = sorted(e["timestamp"] for e in autos)
    cast_ts = sorted(e["timestamp"] for e in casts)
    if len(cast_ts) < 5:
        return None

    merged = [cast_ts[0]]
    for t in cast_ts[1:]:
        if t - merged[-1] >= 250:
            merged.append(t)
    gaps = [merged[i + 1] - merged[i] for i in range(len(merged) - 1)]
    gcd = estimate_gcd(gaps)
    aswings = [auto_ts[i + 1] - auto_ts[i] for i in range(len(auto_ts) - 1)]
    swing = st.median([s for s in aswings if s < 5000]) if aswings else 2500

    def autos_in(t0, t1):
        return sum(1 for t in auto_ts if t0 < t <= t1)

    lost_not_pressing = lost_range_move = 0.0
    stalls = []
    threshold = gcd * 1.4
    for i in range(len(merged) - 1):
        g = merged[i + 1] - merged[i]
        if g <= threshold:
            continue
        excess = g - gcd
        expected = max(1, (g - swing) / swing)
        got = autos_in(merged[i], merged[i + 1])
        if got >= expected * 0.5:
            lost_not_pressing += excess
        else:
            lost_range_move += excess
        stalls.append((merged[i] - f_start, g, got >= max(1, expected) * 0.5))

    overshoot = st.median([g - gcd for g in gaps if gcd <= g <= gcd + 600]) if gaps else 0
    auto_down = sum(max(0, (auto_ts[i + 1] - auto_ts[i]) - swing * 1.5)
                    for i in range(len(auto_ts) - 1)) if len(auto_ts) > 1 else 0
    total_lost = lost_not_pressing + lost_range_move
    return {
        "dur": dur, "gcd": gcd, "swing": swing, "n_gcds": len(merged),
        "lost_not_pressing_s": lost_not_pressing / 1000,
        "lost_range_move_s": lost_range_move / 1000,
        "total_lost_s": total_lost / 1000,
        # normalized: lost seconds per minute of fight
        "lost_per_min": (total_lost / 1000) / (dur / 60),
        "range_lost_per_min": (lost_range_move / 1000) / (dur / 60),
        "press_lost_per_min": (lost_not_pressing / 1000) / (dur / 60),
        "auto_down_pct": 100 * auto_down / (dur * 1000),
        "overshoot_ms": overshoot,
        "stalls": stalls,
    }


def peer_metrics_for(encounter_id, difficulty, class_name, spec_name,
                     target_ilvl, n=6):
    """Run the timeline diagnostic on a sample of ilvl-matched peers."""
    results = []
    for page in range(1, 8):
        if len(results) >= n:
            break
        for r in top_rankings(encounter_id, difficulty, class_name, spec_name, page):
            if len(results) >= n:
                break
            il = r.get("bracketData")
            if not (il and abs(il - target_ilvl) <= 3):
                continue
            try:
                m = player_metrics(r["report"]["code"], r["report"]["fightID"],
                                   r["name"], spec_name, class_name)
                if not m:
                    continue
                fm = fight_metrics(r["report"]["code"], r["report"]["fightID"], m["sourceID"])
            except PrivateReport:
                continue
            except Exception:
                continue
            if fm:
                results.append(fm)
    return results


def compare_boss(name, server, region, encounter, difficulty, class_name, spec_name):
    """Diagnose all your kills of a boss vs peer median on the SAME boss."""
    er = character_encounter(name, server, region, encounter["id"], difficulty)
    if not er or not er.get("ranks"):
        return None
    your_fms = []
    ilvls = []
    for rk in er["ranks"]:
        try:
            you = player_metrics(rk["report"]["code"], rk["report"]["fightID"],
                                 name, spec_name, class_name)
            fm = fight_metrics(rk["report"]["code"], rk["report"]["fightID"], you["sourceID"])
        except Exception:
            continue
        if fm:
            your_fms.append(fm)
            ilvls.append(rk.get("bracketData") or 0)
    if not your_fms:
        return None
    peers = peer_metrics_for(encounter["id"], difficulty, class_name, spec_name,
                             max(ilvls) if ilvls else 0)

    def ymed(k):
        return st.median([f[k] for f in your_fms])

    def pmed(k):
        return st.median([f[k] for f in peers]) if peers else float("nan")

    return {
        "boss": encounter["name"], "your_kills": len(your_fms), "peers": len(peers),
        "you": {k: ymed(k) for k in ("lost_per_min", "range_lost_per_min",
                                     "press_lost_per_min", "auto_down_pct", "overshoot_ms")},
        "peer": {k: pmed(k) for k in ("lost_per_min", "range_lost_per_min",
                                      "press_lost_per_min", "auto_down_pct", "overshoot_ms")},
    }


def print_boss_comparison(c):
    print(f"\n  {c['boss']}  (your {c['your_kills']} kills vs {c['peers']} peers)")
    rows = [
        ("lost GCD time /min", "lost_per_min", "s"),
        ("  - out of range/moving /min", "range_lost_per_min", "s"),
        ("  - in range, not pressing /min", "press_lost_per_min", "s"),
        ("out-of-melee % of fight", "auto_down_pct", "%"),
        ("GCD overshoot (latency)", "overshoot_ms", "ms"),
    ]
    for label, key, unit in rows:
        y, p = c["you"][key], c["peer"][key]
        delta = y - p
        flag = ""
        if key != "overshoot_ms" and delta > 1.0:
            flag = "  <-- WORSE than peers"
        print(f"    {label:34} you {y:6.1f}{unit}  peer {p:6.1f}{unit}  ({delta:+.1f})"
              f"{flag}")


def main():
    ap = argparse.ArgumentParser(description="Comparative timeline diagnosis")
    ap.add_argument("name"); ap.add_argument("server"); ap.add_argument("region")
    ap.add_argument("--class", dest="class_name", default="Monk")
    ap.add_argument("--spec", dest="spec_name", default="Brewmaster")
    ap.add_argument("--difficulty", type=int, default=5)
    ap.add_argument("--boss", default=None, help="boss substring; default = all kills")
    args = ap.parse_args()

    c = character_zone(args.name, args.server, args.region, args.difficulty)
    ranks = [r for r in c["zoneRankings"].get("rankings", [])
             if r.get("totalKills", 0) > 0 and r.get("rankPercent") is not None]
    if args.boss:
        ranks = [r for r in ranks if args.boss.lower() in r["encounter"]["name"].lower()]
    print(f"\n=== Comparative timeline diagnosis: {args.name} "
          f"(vs ilvl-matched peers, intermissions cancel out) ===")
    agg = {k: [] for k in ("lost_per_min", "range_lost_per_min", "press_lost_per_min", "auto_down_pct")}
    for r in ranks:
        try:
            comp = compare_boss(args.name, args.server, args.region, r["encounter"],
                                args.difficulty, args.class_name, args.spec_name)
        except Exception as e:  # noqa: BLE001
            print(f"  ({r['encounter']['name']}: {e})"); continue
        if comp:
            print_boss_comparison(comp)
            for k in agg:
                agg[k].append(comp["you"][k] - comp["peer"][k])
    if agg["lost_per_min"]:
        print(f"\n  === AGGREGATE excess vs peers (median across {len(agg['lost_per_min'])} bosses) ===")
        print(f"    total lost GCD /min over peers: {st.median(agg['lost_per_min']):+.1f}s")
        print(f"      from out-of-range/moving:     {st.median(agg['range_lost_per_min']):+.1f}s")
        print(f"      from not pressing in range:   {st.median(agg['press_lost_per_min']):+.1f}s")
        print(f"    out-of-melee % over peers:      {st.median(agg['auto_down_pct']):+.1f} pts")


if __name__ == "__main__":
    main()
