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
