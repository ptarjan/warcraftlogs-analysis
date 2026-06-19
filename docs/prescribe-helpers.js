// @ts-check
// Pure prescription helpers extracted from prescribe.js: the percent-label / impact
// RECONCILIATION math, the remainder classifier, and the verdict / residual / strengths
// prose builders. No network, no DOM -- unit-tested in test/prescribe.test.mjs. prescribe.js
// imports what it needs; the tests import the rest from here (single source of truth).
import { f, ordinal, DPS, KIND, DIM, metricUnit, throughputWord, runIsHealer } from "./core.js";
import { castable } from "./rotation-helpers.js";

// A single reconciled percent label, e.g. "~11% DPS" (or "~<1% DPS").
export const pctLabel = (n) => (n >= 0.5 ? `~${Math.round(n)}% ${metricUnit()}` : `~<1% ${metricUnit()}`);

// Reconcile the yours-list to the MEASURED headroom so the column ADDS UP to the
// gap instead of being a bag of independent guesses. `target` is the part of the
// measured gap that's plausibly yours (the gap minus comp, which keeps its own
// estimate and is a footnote). Three cases, all making concrete + residual == target:
//  - over-claim (our per-lever sims sum to MORE than the headroom): scale them
//    down so they can't claim more DPS than the gap actually is (this is what
//    shrinks a near-the-field player's list).
//  - under-explain: the leftover is an explicit unattributed residual (execution/
//    sim/variance) -- a player further behind gets a bigger one.
//  - no concrete levers: the whole target is residual.
// Pure math -> unit-testable; the framing of the residual is decided by the caller.
export function reconcileImpacts(impacts, target) {
  const rawSum = impacts.reduce((s, v) => s + (v || 0), 0);
  if (rawSum <= 0) return { scaled: impacts.slice(), residual: Math.max(0, target) };
  if (target <= 0) return { scaled: impacts.map(() => 0), residual: 0 };
  if (rawSum > target) return { scaled: impacts.map((v) => (v || 0) * target / rawSum), residual: 0 };
  return { scaled: impacts.slice(), residual: target - rawSum };
}

// Like reconcileImpacts, but PROTECTS your genuine from-your-log measurements (rotation +
// execution levers) from being scaled down by CONFOUNDED estimates (gear field-deltas,
// consumables, talents). The bug it fixes: a gear field-delta ("peers who stack crit do 18%
// more -- mostly because they're better players") inflated the raw sum and dragged a real
// weak-window / cast-gap lever below its measured value. Your measurements are real, so they
// fill the gap FIRST; the estimates fill only what's left (scaled if they overflow it). If the
// measurements ALONE already exceed the gap, only they scale and the estimates go to 0 --
// your execution explains the whole gap, so a gear swap toward it is ~0% of it. Returns
// parallel scaled arrays + the leftover residual. Pure -> unit-testable.
export function reconcileProtectingMeasured(measured, est, target) {
  if (target <= 0) return { measuredScaled: measured.map(() => 0), estScaled: est.map(() => 0), residual: 0 };
  const M = measured.reduce((s, v) => s + (v || 0), 0);
  if (M >= target) {
    const { scaled } = reconcileImpacts(measured, target);
    return { measuredScaled: scaled, estScaled: est.map(() => 0), residual: 0 };
  }
  const { scaled, residual } = reconcileImpacts(est, target - M);
  return { measuredScaled: measured.slice(), estScaled: scaled, residual };
}

// What the unexplained remainder most likely IS, so we headline it honestly:
//  - "elite":      the player already parses top-decile, so the "field" (the TOP
//                  parses at their ilvl) is an elite sample and the remainder is the
//                  distance to it -- raid comp + optimal-pull execution, NOT a setup
//                  or rotation they're getting wrong. NEVER tell a 94th-%ile player
//                  the gap is "how you play the gear worse" -- it contradicts their
//                  own percentile and isn't actionable.
//  - "healer":     a big remainder on an HPS run -- HPS is bounded by the damage the
//                  raid TAKES and your healing assignment, so the gap to top healers
//                  is mostly the encounter + who else healed + overheal, NOT "how you
//                  play". Don't frame a healer's HPS gap as a personal playstyle deficit.
//  - "support":    a big remainder on a SUPPORT run (Augmentation) -- its throughput
//                  is the amps it puts on ALLIES (credited to their parses), so a
//                  personal-DPS gap mostly measures buff value the comparison can't
//                  see, NOT a personal playstyle deficit. (The buff-uptime lever is
//                  the part the support DOES control -- see the Support card.)
//  - "playstyle":  a big remainder for a NON-elite DAMAGE player -- genuinely how they
//                  play the same gear the field plays (the tool's whole point).
//  - "underpress": a small remainder with a real cast deficit -- GCD uptime.
//  - "small":      a small remainder, no signal -- sim-only tuning + variance.
// Pure -> unit-testable; the caller turns the kind into prose. Precedence: elite
// (selection bias, applies to all roles) before healer before support before playstyle.
export function remainderKind(residual, { elite = false, healer = false, support = false, underPress = false } = {}) {
  if (residual >= 8) return elite ? "elite" : healer ? "healer" : support ? "support" : "playstyle";
  // "underpress" headlines the remainder as GCD-uptime / press-on-more-pulls -- a DAMAGE
  // press-faster conclusion. A healer/support can't have that lever (the press-faster lever
  // itself is !healer && !support gated, and underPress is built from the DAMAGE cast gap),
  // so never headline their small remainder that way; fall through to the role-neutral
  // "small" (sim tuning + variance). Matches the >=8 branch already prioritizing healer/support.
  if (underPress && !healer && !support) return "underpress";
  return "small";
}

// Already top-decile: a big remainder is the gap to the BEST at your ilvl, not a
// personal deficit. Top decile (90th+) is a conservative "this player isn't the
// problem" line.
export const isEliteParse = (medP) => medP != null && medP >= 90;

// Is the player on an OFF-META BUILD the field doesn't run? Signalled by a HERO TREE
// lever (talents.js fires it only when the field strongly favors the OTHER hero
// tree). When true, the rotation can't be compared button-for-button (no same-hero
// peers), so a big "playstyle" remainder is partly the off-meta build itself -- which
// the conservative talent/hero ESTIMATES above under-size -- not pure per-cast play.
export const isOffMetaBuild = (findings) => (findings || []).some((x) => x.kind === KIND.HERO_TREE);

// "WHAT YOU'RE DOING WELL" -- the checks you PASSED. Most levers come back SILENT
// because you're already at or above the field on them; left unsaid, the report
// reads as nothing-but-problems. Surface those passes as positives so the player
// sees what to KEEP (and so a habit they recently fixed reads as a win, not a nag).
// Pure: reads the already-computed domain data (rot/execd/tp/you/field/my); no fetch.
// Metric-aware (DPS vs HPS). Each entry is a short "<TAG>: <why it's good>" string.
export function strengths(d) {
  const { rot, execd, tp, you, field, my } = d || {};
  const out = [];
  const P = (n) => `${Math.round(n)}%`;        // a 0-100 percent
  const F = (n) => `${Math.round(n * 100)}%`;  // a 0-1 fraction
  const W = throughputWord();
  const heal = runIsHealer();
  const peers = rot && rot.fieldPeers > 0;
  // Empowerment: you land your hardest hit in its high-damage window as often as / more
  // than the field (the per-cast lever stays silent because of this -- name the win).
  const pr = rot && rot.proc;
  if (!heal && pr && pr.name && pr.youEmp != null && pr.fieldEmp != null && pr.fieldEmp >= 0.05 && pr.youEmp >= pr.fieldEmp) {
    // Credit it honestly: clearly ahead (5pp+) is "above the field", a tight lead is
    // "in line with" -- don't flatten a player at DOUBLE the field's rate to "at or above"
    // (same call as the remainder line + the EFFICIENCY strength).
    const cmp = pr.youEmp - pr.fieldEmp >= 0.05 ? "above the field" : "in line with the field";
    out.push(`EMPOWERMENT: you land ${pr.name} in its high-damage window ${F(pr.youEmp)} of the time vs the field's ${F(pr.fieldEmp)} -- ${cmp}. Keep timing it.`);
  }
  // Uptime: near-perfect active time (this is why press-faster stayed silent).
  if (execd && execd.activePct != null && execd.activePct >= 98) {
    out.push(`UPTIME: ~${P(execd.activePct)} active -- near-perfect GCD uptime, you're barely idling.`);
  }
  // A benchmark-kill "you do X well" claim is a CONTRADICTION (and erodes trust) when the
  // SAME slip recurs on your OTHER recent bosses -- the benchmark can be your best-played
  // fight. recurKinds (cross-boss) gates the praise so we never say "you skip nothing" next
  // to a HABIT-ACROSS-FIGHTS note that you skip exactly that. (Darckense: ✓ PRIORITY on the
  // one kill where he pressed his rotation, while 2/3 of his bosses spam Death Strike.)
  const recurs = (kind) => !!(d.recurKinds && d.recurKinds.has(kind));
  // Priority: you press the field's buttons (no under-used ability) -- here AND elsewhere.
  if (!heal && peers && rot.usage && (rot.usage.under || []).length === 0 && !recurs("press")) {
    out.push(`PRIORITY: you press the field's priority abilities -- nothing the field casts that you're skipping.`);
  }
  // Cooldowns: none skipped vs the field (on this kill or your other recent ones).
  if (peers && !(rot.cooldowns || []).length && !(rot.cdUsage || []).length && !(rot.buffCds || []).length
      && !recurs("cd") && !recurs("buffcd")) {
    out.push(`COOLDOWNS: you use your ${W} cooldowns on cooldown -- nothing the field gets that you skip.`);
  }
  // DoTs: maintained at field-level uptime (only when you actually run DoTs).
  if (!heal && rot && rot.dotCount > 0 && (rot.dotGaps || []).length === 0 && !recurs("dot")) {
    out.push(`DOTS: your damage-over-time effects are kept up at field-level uptime -- no clipping.`);
  }
  // Targeting: you funnel/cleave the adds about as much as the top parses.
  if (!heal && tp && tp.routing && (tp.routing.addNames || []).length && (tp.routing.top - tp.routing.you) < 5) {
    out.push(`TARGETING: you put about as much damage on the adds as the top parses (${P(tp.routing.you)} vs ${P(tp.routing.top)}) -- good target priority.`);
  }
  // Itemization: your priority stat is at or above the field's -- but only call it "well
  // itemized" when there's no SURVIVING priority-stat gear lever (a swap, or a recraft we
  // didn't suppress). "You can't be doing-well at a thing you still have a lever for" --
  // the same gate PRIORITY/DOTS use. A recraft suppressed because you out-stack the field
  // (aboveField) is NOT a lever, so it doesn't block the win (Rammrod: above the field on
  // haste, over-stacking recrafts dropped -> this honestly reads "well itemized").
  const priorityGearLever = d.gf && (((d.gf.swaps || []).length) || ((d.gf.restats || []).length && !d.aboveField));
  if (my && my.statPct != null && field && field.statPct != null && my.statPct >= field.statPct && !priorityGearLever) {
    out.push(`GEAR: your ${d.priority} is at or above the field's (${P(my.statPct)} vs ${P(field.statPct)}) -- well itemized.`);
  }
  // Healer efficiency: overheal at or below the field's (not spilling).
  // Fires when you're not FLAGGED as spilling (within the OVERHEALING lever's noise
  // band, i.e. <= field + 5pp) -- but only CLAIM "at or below" when you actually are;
  // 1-5pp above the field is "in line with", not below (Cheoeqar: 31% vs the field's 29%).
  if (heal && you && you.overhealPct != null && field && field.overhealMed != null && you.overhealPct <= field.overhealMed + 5) {
    out.push(you.overhealPct <= field.overhealMed
      ? `EFFICIENCY: your ${P(you.overhealPct)} overheal is at or below the field's ${P(field.overhealMed)} -- efficient healing, not spilling.`
      : `EFFICIENCY: your ${P(you.overhealPct)} overheal is in line with the field's ${P(field.overhealMed)} -- not spilling more than your peers.`);
  }
  return out;
}

// THE SYNTHESIS, rendered: one answer anchored on the MEASURED DPS gap (your
// kill vs the ilvl-matched field vs the top parses -- real numbers, not a sum of
// per-lever guesses), what that gap is made of, then the change-list split into
// "yours to do" vs raid comp. Pure presentation -- the analysis already happened.
// Which character lever the VERDICT should headline. `yours` MUST be the
// actionable findings sorted by impact desc (comp + the playstyle remainder
// excluded) -- yours[0] is the biggest lever, so the verdict can never claim a
// lever is "biggest / sort that first" when a bigger one outranks it in the list.
// A talent swap is dim "Rotation" but should read as a BUILD lever, so check kind first.
export function verdictLever(yours) {
  const top = yours && yours[0];
  if (!top) return "none";
  if (top.kind === KIND.TALENTS || top.kind === KIND.HERO_TREE) return "build";
  if (top.dim === DIM.ROTATION) return "rotation";
  if (top.dim === DIM.GEAR || top.dim === DIM.SETUP) return "setup";
  if (top.dim === DIM.EXECUTION) return "execution";
  return "none";
}

// Verdict-relevant sections that, when SKIPPED (rate limit), make a "nothing to fix"
// all-clear dishonest: we can't claim build/gear/rotation "match the field" if we never
// loaded them. (A "top-parse comparison" / "boss-debuff comp" skip doesn't undercut that
// specific claim, so it's excluded.) Returns the offending skip labels. Pure -> testable.
export const verdictBlindSpots = (skipped) => (skipped || []).filter((s) => /rotation|talents|gear/.test(s));

// The verdict's "not a <domain> overhaul" reassurance (e.g. a rotation verdict adding
// "not a setup overhaul", or a setup verdict adding "not a rotation overhaul") is only
// honest if we actually LOADED that domain. Under a partial run that skipped it, DROP the
// clause rather than assert a domain we never checked -- the NOTE above already says what's
// missing. domain "setup" maps to the gear/consumables skip; "rotation" to the rotation
// skip. Returns "" (omit) or the disclaimer clause. Pure -> testable.
export const overhaulDisclaimer = (domain, skipped) => {
  const skipPat = domain === "rotation" ? "rotation" : "gear";
  return (skipped || []).some((s) => s.includes(skipPat)) ? "" : `, not a ${domain} overhaul`;
};

// The prose for the unexplained REMAINDER, by remainderKind (see that fn for why each
// kind exists). The big one is NOT "press faster" -- a big remainder is the analysis
// admitting it can't fully explain the gap, so it's framed by kind, never relabeled as a
// small lever. `r` is the rounded residual %; rot/rx provide the measured pieces to cite.
export function residualText(kind, r, d, rot, rx) {
  if (kind === "elite") {
    // Already top-decile: the remainder is the distance to the BEST parses at your ilvl,
    // not a setup/rotation you're getting wrong. Don't manufacture a "playstyle" problem.
    return `GAP TO TOP PARSES (~${r}%): you already parse ${ordinal(d.medP)} percentile, so the "field" is the BEST players at your item level and this is the distance to them -- raid comp + optimal-pull execution (lust/cooldown windows, target swaps), not gear or a rotation you're getting wrong.`;
  }
  if (kind === "healer") {
    // HPS is bounded by the damage the raid TAKES + your assignment -- a big HPS remainder
    // is mostly the encounter/healer comp/overheal, NOT a personal playstyle gap.
    return `HEALING IS DAMAGE-BOUND (~${r}%): HPS is capped by the damage your raid takes and your assignment -- you can't out-heal damage that didn't happen. Most of this gap is the encounter, healer comp, and overheal, not how you play. The levers above are what you control; chase effective throughput, not raw HPS.`;
  }
  if (kind === "support") {
    // A support's personal DPS is a fraction of their value: Ebon Might / Prescience amp
    // ALLIES, credited to THEIR parses. A big personal-DPS remainder is buff value the
    // comparison can't see; what they control is buff UPTIME, not personal damage.
    return `SUPPORT VALUE IS OFF YOUR SHEET (~${r}%): your throughput is mostly the amps you keep on allies (Ebon Might / Prescience / Breath of Eons), which WCL credits to THEIR parses -- so this gap is buff value a personal-DPS comparison can't see, not DPS you can add. What you control is buff UPTIME (see the Support card) and your cooldown/gear use above.`;
  }
  if (kind === "playstyle") {
    // A big remainder at matched ilvl is NOT gear/sim and NOT "press faster" -- it's
    // PLAYSTYLE. The concrete pieces are their OWN levers above; for the rest we DIRECTLY
    // check empowerment with a measured fact (your biggest hit's empowered share vs the
    // field). If yours trails -> point at it; if it matches, say so -- the gap is per-cast
    // damage, not a button. Only cite castable under-pressed abilities (a respec lever
    // otherwise). Never hand-wave "sequencing".
    // Cite ONLY under-pressed abilities that AREN'T already their own concrete line item.
    // An ability promoted to a sized "press X more" lever (recurKey `press:<name>`) is part
    // of the EXPLAINED gap, not the residual -- re-citing it here read as double-counting
    // ("press Raging Blow more" as item #5, then "your playstyle gap is pressing Raging Blow
    // less"). Excluding them leaves only the genuinely-unlisted ones; if none remain, the
    // cite falls through to "the measurable gaps are listed above".
    // Rotation fail-soft skipped (throttle / private log) -> `rot` is null and there are NO
    // cooldown/ability gaps in the list, so the "listed above" fallbacks below would lie.
    const rotSkipped = (d.skipped || []).some((s) => /rotation/.test(s));
    const listedPress = new Set((rx || [])
      .filter((x) => typeof x.recurKey === "string" && x.recurKey.startsWith("press:"))
      .map((x) => x.recurKey.slice(6)));
    const under = ((rot && rot.usage && rot.usage.under) || [])
      .filter((a) => castable(a.name, rot && rot.talent) && !listedPress.has(a.name));
    const pr = rot && rot.proc;
    const ep = (n) => `${Math.round(n * 100)}%`;
    // Only cite empowered shares when the ability HAS a meaningful empowered version in
    // the field (fieldEmp > ~5%); a uniform-hit ability would print a meaningless "0% vs 0%".
    const hasEmp = pr && pr.youEmp != null && pr.fieldEmp != null && pr.fieldEmp >= 0.05;
    // Point at "the EMPOWERMENT item" ONLY when that lever actually fired -- its gates
    // are stricter than this cite's (field empowers >= 20%, per-cast gap >= 1%), so a
    // fieldEmp in [5%,20%) or a sub-1% gap trails enough to cite here but produces NO
    // EMPOWERMENT lever -> a dangling "(see the EMPOWERMENT item)". Check by kind (robust
    // to threshold drift), like the off-meta-build / overheal-pointer gates.
    const hasEmpItem = (rx || []).some((x) => x.kind === KIND.EMPOWERMENT);
    // A LARGE remainder is a DIAGNOSTIC, not cosmetics: per the project rule, NEVER
    // punt a big chunk to "confounded per-cast stats / go sim it". Give the same
    // actionable execution directions an elite gets (cooldown/Bloodlust-window timing,
    // sequencing, uptime through movement) + the concrete next step. Only a SMALL
    // remainder is genuinely just stat variance.
    const big = r >= 25;
    const frontier = ` A gap this size isn't just stat variance -- it's execution: aligning cooldowns with Bloodlust/burst windows, sequencing, and uptime/DoTs/buffs through movement (plus comp re-attribution + fight-amp windows you don't fully control). Pull up a rank-1 parse of this exact fight and diff its timeline against yours.`;
    const perCastTail = ` The gap is per-cast ${throughputWord()} (crit/stats, plus comp re-attribution + fight-amp windows you don't fully control).`;
    // Empowered-share band -- only reached when the EMPOWERMENT lever DIDN'T fire (gap
    // < 12pp). Ahead or within 5pp => timing ISN'T the culprit. But 5-12pp BEHIND (e.g.
    // a Feral at 11% vs 21% -- half the field's rate) means timing/snapshotting likely
    // IS part of it, just under the lever's bar: NEVER tell that player "you land it
    // nearly as often, so it's NOT timing" -- that dismisses the most likely lever.
    const empBehind = hasEmp && pr.youEmp < pr.fieldEmp - 0.05;
    const empWord = !hasEmp ? "" : pr.youEmp - pr.fieldEmp >= 0.05 ? "more often than"
      : pr.youEmp >= pr.fieldEmp - 0.05 ? "about as often as" : "less often than";
    const cite = hasEmp && pr.fieldEmp - pr.youEmp >= 0.12
      ? ` The biggest piece: only ${ep(pr.youEmp)} of your ${pr.name} casts land empowered vs the field's ${ep(pr.fieldEmp)}${hasEmpItem ? " (see the EMPOWERMENT item)" : ""} -- the rest is per-cast ${throughputWord()} (crit/stats + comp & fight amps).`
      : hasEmp && !empBehind
      ? ` Your ${pr.name} lands empowered ${empWord} the field (you ${ep(pr.youEmp)} vs ${ep(pr.fieldEmp)}), so it's NOT timing.${big ? frontier : perCastTail}`
      : hasEmp
      ? ` Your ${pr.name} lands empowered ${empWord} the field (you ${ep(pr.youEmp)} vs ${ep(pr.fieldEmp)}) -- so part of this likely IS timing (under the bar where we'd name it a lever): land your hardest hit in its high-damage window more often.${big ? frontier : ""}`
      : under.length
      ? ` Part of it: you press ${under.slice(0, 2).map((a) => `${a.name} ${f(a.you, 1)}/min vs ${f(a.field, 1)}`).join(", ")}.${big ? frontier : ""}`
      : rotSkipped
      // Rotation didn't load this run (rate-limited / private log) -- that's the cooldown/
      // ability breakdown, so DON'T claim it's "listed above" (it isn't). Say so honestly.
      ? ` Your rotation analysis didn't load this run (rate-limited or a private log) -- that's where the cooldown/ability breakdown lives, so re-run to see what's behind this.${big ? frontier : ""}`
      : big
      ? ` The measurable cooldown/ability gaps are listed above.${frontier}`
      : ` The measurable cooldown/ability gaps are listed above; the rest is per-cast ${throughputWord()} (crit/stats + comp & fight amps) we can't pin to one ability.`;
    // Off-meta build: no same-hero peers to compare against, so a big part of the
    // remainder is the build itself (HERO TREE + TALENTS items), not "how you play".
    // Don't say "NOT press faster" when a PRESS FASTER lever is ALREADY in the list
    // above (the idle we COULD measure) -- the two collide and read as a contradiction.
    // In that case the remainder is the part BEYOND that measured idle: still per-cast,
    // not more idling. Phrase it so the two don't fight.
    const hasPressItem = (rx || []).some((x) => x.kind === KIND.PRESS_FASTER);
    const notGear = `it's NOT gear (a sim would value your gear swaps at a few %)`;
    const playstyleBody = hasPressItem
      ? `${notGear}. Beyond the idle gap above, it's not just pressing faster either -- it's how you play the same gear the field plays`
      : `${notGear} and NOT "press faster" -- it's how you play the same gear the field plays`;
    return isOffMetaBuild(rx)
      ? `OFF-META BUILD + PLAYSTYLE (~${r}%): a large part is your BUILD -- you run a hero tree (and talents) the field doesn't (see the HERO TREE + TALENTS items), so your rotation can't be compared button-for-button and a sim would value the swap well above the estimate above. Switch to the meta build and re-run first.${cite}`
      : `PLAYSTYLE (~${r}%): the biggest chunk -- ${playstyleBody}.${cite}`;
  }
  if (kind === "underpress") {
    return `THE REMAINDER (~${r}%): not a setup item -- it's GCD uptime and hitting your priority on more pulls (see the cast/idle gaps above).`;
  }
  return `THE REMAINDER (~${r}%): small and unattributed -- sim-only tuning (exact trinket/stat effect sizes) and kill-to-kill variance. No single button.`;
}

// The ONE-LINE "your gap breaks down as ..." summary must NAME the residual the same
// way the detailed item below does -- not call it "not yet explained" when the report
// then explains it (a healer's gap is damage-bound, an elite's is the distance to the
// top parses). "Not yet explained" reads as the tool giving up / blaming the player,
// and for a 62nd-pct healer told they're "171% behind" it directly contradicts the
// detail. Only the genuinely-uncharacterized DPS remainder stays "not yet explained".
export function residualSummary(kind) {
  switch (kind) {
    case "elite": return "the gap to the top parses";
    case "healer": return "damage-bound (capped by the damage your raid took)";
    case "support": return "buff value off your sheet (credited to allies)";
    case "playstyle": return "playstyle (how you play the same gear -- see below)";
    case "underpress": return "GCD uptime / execution";
    case "small": return "sim tuning + kill-to-kill variance";
    default: return "not yet explained";
  }
}

// Did this consumable's buff land? (Uptime strictly above its floor + name matches.)
export const consumableHit = (c, lc, b) => b.pct > c.minPct && c.match(lc);

// The curated consumable list: how to detect each (name keyword + uptime floor) and what
// missing it is worth. Shared by prescribe's field tally and prescribe-levers' consumableLevers.
export const CONSUMABLES = [
  { field: "flasks", mine: "flask", label: "FLASK", peerVerb: "run", note: "",
    match: (lc) => lc.includes("flask"), minPct: 50,
    none: DPS(2), missText: "you ran none", tail: "Free parse with equal gear.", swap: DPS(2) },
  { field: "foods", mine: "food", label: "FOOD", peerVerb: "run", note: "",
    match: (lc) => lc.includes("well fed"), minPct: 50,
    none: DPS(1, 2), missText: "you ate none", tail: "Free parse.", swap: DPS(1) },
  { field: "potions", mine: "potion", label: "COMBAT POTION", peerVerb: "pop",
    note: " (during your burst window)", swapNeedsMeasure: true,
    match: (lc) => lc.includes("potion") && !lc.includes("healing"), minPct: 0,
    none: DPS(1, 3), missText: "you used none", tail: "Free parse with equal gear.", swap: DPS(1) },
  { field: "augRunes", mine: "augrune", label: "AUGMENT RUNE", peerVerb: "use",
    note: " (a flat primary-stat gain)",
    match: (lc) => lc.includes("augment rune"), minPct: 50,
    none: DPS(1, 2), missText: "you ran none", tail: "Free parse.", swap: DPS(1) },
  { field: "oils", mine: "oil", label: "WEAPON OIL", peerVerb: "apply",
    note: " (a temporary weapon buff, re-applied like a flask)",
    match: (lc) => /\boil\b|sharpening|whetstone|weightstone/.test(lc), minPct: 50,
    none: DPS(1, 2), missText: "you ran none", tail: "Free parse.", swap: DPS(1) },
];
