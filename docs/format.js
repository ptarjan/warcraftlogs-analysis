// @ts-check
// Pure formatting + aggregation helpers -- no app/WCL/DOM dependencies. Number and
// column formatting, slug, the small Map/array reducers, and the integer-percent helper
// used across the analyses. (Split out of core.js so the foundation reads in cohesive
// files; core.js re-exports these for back-compat.)

// Number formatting (approximate the Python f-string columns): grouped, fixed decimals.
export function f(x, d = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "nan";
  return Number(x).toLocaleString("en-US", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
}
export const padL = (s, n) => String(s).padStart(n);
export const padR = (s, n) => String(s).padEnd(n);
export const slug = (s) => s.toLowerCase().replaceAll(" ", "-");

// --- the shared READOUT grammar -------------------------------------------------
// Every analysis card EXCEPT the prescription renders as a monospace .readout that the
// app styles by a tiny grammar: `=== head ===`, `--- sub ---`, `-> takeaway`, `<-- flag`.
// These helpers are the ONE definition of that grammar so the panels read as one product
// instead of eight ad-hoc dumps -- a card that builds its header/takeaway/units by hand
// drifts (overview printed raw "27,999 dps", prescribe "66.7k"; every card titled itself
// differently). Pure string-returners; the module still owns WHAT to say.

// k/M number formatting -- the single definition so throughput reads identically on every
// card (28k, 1.2M). Matches the chart axis formatter in app.js.
export function kfmt(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e6) return `${f(n / 1e6, 1)}M`;
  if (v >= 1e3) return `${Math.round(Number(n) / 1e3)}k`;
  return `${Math.round(Number(n) || 0)}`;
}
// Section head / subhead -> the app maps these to .r-head / .r-sub. Use head() for the
// card's sections, NOT to restate the card's own title (the card chrome already shows it).
export const head = (title) => `=== ${title} ===`;
export const subhead = (title) => `--- ${title} ---`;
// The "so what" line (.r-call, gold). Every readout card should close with exactly one --
// the single sentence the player leaves with. `log(arrow("..."))`.
export const arrow = (text) => `-> ${text}`;
// A you-vs-peer flag suffix, consistent across cards: append to a row. Only marks the
// ACTIONABLE side (WORSE) by default -- matching the existing convention -- and stays
// silent within `noise`. `lowerIsBetter` for metrics where less is good (lost GCDs, ms).
// The app colors a flag green only when it matches /(more|good|ok|✓)/, so "better" carries
// a ✓ to read as positive; "WORSE" reads red.
export function flag(you, peer, { lowerIsBetter = false, noise = 0, both = false } = {}) {
  const diff = (Number(you) || 0) - (Number(peer) || 0);
  if (Math.abs(diff) <= noise) return "";
  const worse = lowerIsBetter ? diff > 0 : diff < 0;
  if (worse) return "  <-- WORSE than peers";
  return both ? "  <-- ✓ better than peers" : "";
}

// English ordinal suffix for a whole number: 1->"1st", 2->"2nd", 3->"3rd",
// 62->"62nd", 91->"91st", but 11/12/13 -> "th". The single definition for the
// "${p}th percentile" sites that blindly appended "th" (printing "62th",
// "91th", "33th"). Use `ordinal(p)` instead of `${p}th`.
export function ordinal(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return String(n);
  const a = Math.abs(v) % 100;
  const suffix = (a >= 11 && a <= 13) ? "th"
    : ["th", "st", "nd", "rd"][Math.abs(v) % 10] || "th";
  return `${v}${suffix}`;
}

// Top-n [key, count] entries of a Map counter, highest count first. The single
// definition for the "most popular item/gem/trinket the field runs" pattern that was
// re-inlined (`[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n)`) across modules.
export const topN = (counter, n = Infinity) =>
  counter ? [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, n) : [];
// Highest-count [key, count] entry of a Map counter, or null when empty.
export const topEntry = (counter) => topN(counter, 1)[0] || null;

export function median(arr) {
  const a = arr.filter((x) => x !== null && x !== undefined && !Number.isNaN(x))
    .slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Round a ratio to an integer percent: pct(n, d) === Math.round(100*n/d). The single
// definition for the ~30 inline `Math.round(100*x/y)` sites. Optional cap/floor clamp
// the result; {round:false} keeps the float. d <= 0 -> 0 (no divide-by-zero / NaN).
export function pct(n, d, { cap = Infinity, floor = -Infinity, round = true } = {}) {
  if (!(d > 0)) return 0;
  const v = Math.min(cap, Math.max(floor, (100 * n) / d));
  return round ? Math.round(v) : v;
}
