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
