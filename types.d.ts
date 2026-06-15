// Ambient project types -- the shared "currency" the analyses pass to prescribe.
// No imports/exports here, so these names are globally available in any file that
// opts into checking with `// @ts-check` (referenced in JSDoc as {Finding} etc.).
// Type-check only; emits nothing.

/** Wowhead's tooltip widget (power.js), loaded via a <script> in index.html. */
interface Window {
  $WowheadPower?: { refreshLinks?: () => void };
}

/** Which analysis a finding came from (splits "yours to do" from raid comp). */
type Dim = "Execution" | "Rotation" | "Setup" | "Gear" | "Comp"
  | "Info" | "Survival" | "DPSCheck" | "Mechanic" | "Roster"; // progression.js (raid-night pull analyzer)

/** impact (the ONLY sort key) + its matching display label, built together. */
interface Score {
  impact: number;
  label: string;
}

/** One ranked change. impact sorts the list; dim splits it; text is shown. */
interface Finding extends Score {
  dim: Dim;
  text: string;
  /** How impact was derived: "measured" (from the log) vs "est" (a sim would price it). */
  basis?: "measured" | "est";
  /** Stable machine tag (KIND.*) for kinds prescribe special-cases, so it keys off this
   *  instead of regex-matching `text`. Absent for ordinary levers. */
  kind?: string;
}

/** A measured value from the ilvl-matched field: median DPS of peers who HAVE a thing
 *  minus those who don't, as a % (core.fieldDelta). null = no counterfactual to measure. */
interface FieldDelta {
  pct: number;
  nHave: number;
  nNot: number;
}

/** A FieldDelta plus the per-rating slope, for sizing a gear swap from the field
 *  (gear.statValueScore). null when the field gave no counterfactual. */
interface StatValue {
  pct: number;
  perRating: number;
  nHave: number;
  nNot: number;
}

/** The ilvl-matched field's gear/consumable/stat picture (prescribe.fieldGearConsumables).
 *  Tallies = what the field RUNS (Maps of name/id -> count); deltas = each lever's MEASURED
 *  value from that sample (FieldDelta | null). One named shape instead of an ad-hoc bag. */
interface PeerField {
  enchBySlot: Record<string, Map<string, number>>;     // slot name -> (enchant -> count)
  trinkets: Map<number, { name: string; count: number }>;
  flasks: Map<string, number>; foods: Map<string, number>; potions: Map<string, number>;
  augRunes: Map<string, number>; oils: Map<string, number>;
  guids: Map<string, number>;                          // consumable name -> spell id (links)
  deltas: Record<string, FieldDelta | null>;           // value of having ANY, per consumable
  topDeltas: Record<string, FieldDelta | null>;        // value of the field's TOP item (a swap)
  statDelta: FieldDelta | null;                        // priority stat, top vs bottom half by %
  statValue: { pct: number; perRating: number; nHave: number; nNot: number } | null; // per rating point
  gemDelta: FieldDelta | null;
  compDeltas: Record<string, FieldDelta>;              // self-buff raid amps, by RAID_DAMAGE key
  statPct: number | null;                              // field-median priority-stat %
  n: number;                                           // peers sampled
  dpsMed: number | null;                               // measured field throughput (the gap baseline)
  overhealMed: number | null;                          // field-median overheal % (healer baseline)
}

/** Parsed Wowhead item data (gear.js itemStats): secondary stats + where it's from. */
interface ItemStats {
  name: string;
  crit: number;
  haste: number;
  mastery: number;
  vers: number;
  ilvl: number | null;
  embellished: boolean;
  unique: boolean;
  source: string | null;      // "Dropped by: <boss>"
  dropChance: string | null;
  crafted: boolean;
}
