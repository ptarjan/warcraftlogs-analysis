// Ambient project types -- the shared "currency" the analyses pass to prescribe.
// No imports/exports here, so these names are globally available in any file that
// opts into checking with `// @ts-check` (referenced in JSDoc as {Finding} etc.).
// Type-check only; emits nothing.

/** Which analysis a finding came from (splits "yours to do" from raid comp). */
type Dim = "Execution" | "Rotation" | "Setup" | "Gear" | "Comp";

/** impact (the ONLY sort key) + its matching display label, built together. */
interface Score {
  impact: number;
  label: string;
}

/** One ranked change. impact sorts the list; dim splits it; text is shown. */
interface Finding extends Score {
  dim: Dim;
  text: string;
}
