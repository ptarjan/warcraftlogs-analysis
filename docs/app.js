// @ts-check
// UI wiring: pick character/region/server, auto-detect the rest, then render
// the result as a web report -- the prioritized list of changes up top, with
// the supporting analyses as collapsible cards below.
import { detectContext, detectPriority, DIFFICULTY, raidTeammates, slug, metricForSpec, setRunContext, isSupport, metricUnit, runIsHealer,
  parseReportRef, reportFights, recentReportsFor, mapLimit } from "./core.js";
import { isAuthed, beginLogin, handleRedirectCallback, logout, NeedsAuth } from "./auth.js";
import { myCharacters, primeRateReset, fmtRateWait, pruneStaleCache } from "./wcl.js";
import { paramsFromSearch, shareSearch, encodeSnapshot, decodeSnapshot, snapshotFromHash } from "./share.js";
import { tokenizeMarkup } from "./markup.js";
import { renderDpsChart } from "./dps-chart.js";
import * as progression from "./progression.js";
import * as overview from "./overview.js";
import * as timeline from "./timeline.js";
import * as graph from "./graph.js";
import * as rotation from "./rotation.js";
import * as talents from "./talents.js";
import * as topparse from "./topparse.js";
import * as gear from "./gear.js";
import * as consumables from "./consumables.js";
import * as healing from "./healing.js";
import * as support from "./support.js";
import * as prescribe from "./prescribe.js";

/** Look up a known element. Typed loosely (any) on purpose -- this is DOM glue;
 *  the analysis modules are where type-checking earns its keep.
 *  @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const out = $("out"), statusEl = $("status"), goBtn = $("go"), form = $("form");
const regionSel = $("region"), serverSel = $("server"), authEl = $("auth");
const modebar = $("modebar"), progForm = $("progform"), progPicker = $("progpicker");

// Which flow is active: "player" (the per-character DPS list) or "progression"
// (the raid-night pull analyzer). The mode toggle (modebar) flips it when connected.
let mode = "player";

// Escape user-supplied text before it goes into innerHTML (e.g. a character name
// from a URL param shown in the connect prompt).
const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- server dropdown, populated from the bundled realm list per region --- //
let REALMS = {};
const realmsReady = loadRealms();
async function loadRealms() {
  try { REALMS = await (await fetch("./servers.json")).json(); }
  catch (e) { REALMS = {}; }
  fillServers();
}
function fillServers() {
  const list = REALMS[regionSel.value] || [];
  serverSel.innerHTML = list.map((s) => `<option value="${s.slug}">${s.name}</option>`).join("")
    || '<option value="">(realm list unavailable)</option>';
}
regionSel.addEventListener("change", fillServers);

// --------------------------------------------------------------------------- //
// Auth (REQUIRED): the app is connect-only. The browser runs every analysis on
// the user's OWN Warcraft Logs PKCE token -- their own hourly point budget (a
// full run is too heavy for any shared budget) and access to their private logs.
// No app secret in the page. Once connected they can analyze ANY character.
// --------------------------------------------------------------------------- //
function renderAuth() {
  if (isAuthed()) {
    authEl.innerHTML =
      '<span class="conn ok">✓ Connected · using your Warcraft Logs account</span>' +
      '<button type="button" id="refresh-cache" class="linkbtn" title="Re-fetch the field you\'re compared against (rankings drift ~weekly). Keeps cached kill data, so it won\'t re-spend your point budget.">Force refresh</button>' +
      '<button type="button" id="disconnect" class="linkbtn">Disconnect</button>';
    // Drop the drift-able (rankings/character) cache so the next run compares you to a
    // FRESH field, then reload to re-analyze. Keeps immutable kill reports cached (no
    // point re-spend). Fixes the "stale field still says you're X% behind" case.
    $("refresh-cache").onclick = async () => {
      const btn = $("refresh-cache");
      btn.disabled = true; btn.textContent = "Refreshing…";
      try { const { dropped } = await pruneStaleCache(); btn.textContent = `Cleared ${dropped} · reloading…`; }
      catch { /* reload anyway */ }
      location.reload();
    };
    $("disconnect").onclick = () => { logout(); renderAuth(); renderMode(); };
  } else {
    // The prominent Connect call-to-action lives in the connect-prompt card
    // (renderConnectPrompt); don't duplicate a second button in the header.
    authEl.innerHTML = '<span class="conn muted">not connected</span>';
  }
}
function showAuthErr(e) { cur = makeCard("Connection error"); note(e.message || String(e), "err"); }

// Display name for a realm slug (characters from WCL carry only the slug).
function realmLabel(region, slug) {
  const r = (REALMS[region] || []).find((s) => s.slug === slug);
  return r ? r.name : slug;
}

// Connect-only, two states:
//   NOT connected -> hide the form; show a Connect prompt (no analysis without
//     your own account). The sample below stays as the marketing.
//   connected     -> show the search form (analyze ANY character -- yours or a
//     friend's) AND, below it, a one-click list of YOUR own characters.
// Best-effort: if your character list can't be built, just the form shows.
// A character the user asked for before connecting (a shared deep link). Handed
// to beginLogin() as returnState so it auto-runs the moment they're connected.
let pendingChar = null;

function renderConnectPrompt(picker) {
  picker.style.display = "";
  picker.innerHTML = "";
  const box = document.createElement("div");
  box.className = "connect-prompt";
  const resumeNote = pendingChar
    ? ` You'll see <b>${escapeHtml(pendingChar.name)}</b>'s list right after connecting.` : "";
  box.innerHTML =
    '<div class="cp-t">Connect to get your to-do list</div>' +
    '<div class="cp-s">Each analysis runs on <b>your own</b> account\'s hourly budget — so it stays fast ' +
    'and can read your private logs. Once connected, analyze <b>any</b> character: yours in one click, ' +
    'or a friend\'s by name.' + resumeNote + '</div>';
  const b = document.createElement("button");
  b.type = "button"; b.className = "linkbtn accent"; b.textContent = "Connect Warcraft Logs";
  // Pass the pending character as returnState so the redirect resumes it.
  b.onclick = () => beginLogin(pendingChar || undefined).catch(showAuthErr);
  box.appendChild(b);
  picker.appendChild(box);
}
// Reverse of realmLabel: a realm display name (as it comes off a report roster)
// -> the slug the analysis needs. Prefer the canonical slug from servers.json;
// fall back to slugifying the name.
function realmSlug(region, realmName) {
  const r = (REALMS[region] || []).find((s) => s.name.toLowerCase() === String(realmName).toLowerCase());
  return r ? r.slug : slug(String(realmName));
}

// One clickable character button (your own or a teammate). `extra` is the right-
// hand subline detail; `cls` lets teammates render differently.
function charButton({ name, server, region, label, extra, cls = "charbtn" }) {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls;
  const cn = document.createElement("span"); cn.className = "cn"; cn.textContent = name;
  const cs = document.createElement("span"); cs.className = "cs";
  cs.textContent = `${label} · ${region}` + (extra ? ` · ${extra}` : "");
  b.append(cn, cs);
  b.onclick = () => runAnalysis({ name, server, region, serverLabel: label });
  return b;
}

let pickerRun = 0; // guards against a stale async teammates append after a re-render

// Show only the active flow's input. The modebar appears once connected; the
// player form/picker and the progression form/picker are mutually exclusive.
function applyMode() {
  const authed = isAuthed();
  if (modebar) modebar.style.display = authed ? "" : "none";
  const showPlayer = authed && mode === "player";
  const showProg = authed && mode === "progression";
  form.style.display = showPlayer ? "" : "none";
  const picker = $("picker"); if (picker && !showPlayer) picker.style.display = "none";
  if (progForm) progForm.style.display = showProg ? "" : "none";
  if (progPicker && !showProg) progPicker.style.display = "none";
  // Once you're connected the marketing/EXAMPLE intro is just taking up space the
  // picker (your characters / your raid nights) can use -- hide it when authed.
  const intro = document.getElementById("intro"); if (intro) intro.style.display = authed ? "none" : "";
  if (modebar) for (const t of modebar.querySelectorAll(".modetab")) t.classList.toggle("active", t.dataset.mode === mode);
}
// Remember the active tab in the URL so a reload / browser-back keeps you on it.
function syncModeUrl() {
  try { history.replaceState(null, "", location.pathname + (mode === "progression" ? "?mode=progression" : "")); } catch (e) { /* ignore */ }
}
function setMode(m) { mode = m; syncModeUrl(); applyMode(); renderMode(); }
if (modebar) for (const t of modebar.querySelectorAll(".modetab")) t.onclick = () => setMode(t.dataset.mode);

async function renderMode() {
  const picker = $("picker");
  if (!isAuthed()) {
    applyMode();
    if (picker) renderConnectPrompt(picker);
    return;
  }
  applyMode();
  if (mode === "progression") { renderProgPicker(); return; }
  // Connected: the form analyzes any character; the picker is a shortcut to yours.
  if (!picker) return;
  const run = ++pickerRun;
  let chars = [];
  try { chars = await myCharacters(); } catch { chars = []; }
  await realmsReady;
  if (run !== pickerRun) return;
  if (!chars.length) { picker.style.display = "none"; picker.innerHTML = ""; return; }
  picker.style.display = "";
  picker.innerHTML = "";
  const h = document.createElement("div");
  h.className = "picker-h";
  h.textContent = "Your characters — or type any character above";
  picker.appendChild(h);
  const grid = document.createElement("div");
  grid.className = "picker-grid";
  for (const c of chars) {
    const extra = c.kills ? `${c.kills} kill${c.kills === 1 ? "" : "s"}` : "";
    grid.appendChild(charButton({ name: c.name, server: c.server, region: c.region, label: realmLabel(c.region, c.server), extra }));
  }
  picker.appendChild(grid);
  appendTeammates(picker, chars, run); // best-effort, async -- doesn't block the picker
}

// People you commonly raid with (from your kills' rosters), shown as a separate,
// visually-distinct group below your own characters. Best-effort + lazy.
//
// You may raid with DIFFERENT teams on different characters (a Mythic main on one
// realm, an alt-run on another) AND at different DIFFICULTIES on the same character
// (a cross-realm Mythic group + a guild Heroic group). raidTeammates only sees ONE
// character at ONE difficulty, so the old chars[0]/top-difficulty-only scan hid every
// other team. Scan your top few characters across Mythic + Heroic and render a section
// per distinct team. De-dupe across sections so a team you reach more than one way
// (two characters, or Heroic + Mythic in a lockout) shows once. Bounded for quota.
const MATES_PICKER_CHARS = 3;     // your characters to scan for teammates (bounded for quota)
const MATES_DIFFS = [5, 4];       // Mythic, then Heroic -- where real teams are (skip Normal/LFR pugs)
async function appendTeammates(picker, chars, run) {
  const scan = chars.slice(0, MATES_PICKER_CHARS);
  if (!scan.length) return;
  // One list per (character, difficulty). Bounded concurrency; identical roster queries
  // are cached, so a raid night logged at both Heroic and Mythic isn't re-fetched.
  const jobs = [];
  for (const c of scan) for (const d of MATES_DIFFS) jobs.push({ c, d });
  const lists = await mapLimit(jobs, 3, ({ c, d }) =>
    raidTeammates(c.name, c.server, c.region, { difficulty: d, maxReports: 8 })
      .then((m) => ({ c, d, m })).catch(() => ({ c, d, m: [] })));
  if (run !== pickerRun) return;                        // re-rendered while we fetched
  // De-dupe across sections (and against your own alts): a teammate surfaced by an
  // earlier section (a higher difficulty, or another of your characters) is dropped
  // from later ones, so each team shows its DISTINCT members and the same team reached
  // two ways collapses instead of repeating. Jobs are ordered character-major,
  // difficulty-descending, so a team's Mythic section wins over its Heroic one.
  const seen = new Set(chars.map((c) => `${c.name}|${c.server}`.toLowerCase()));
  const sections = [];
  for (const { c, d, m } of lists) {
    const rows = (m || [])
      .map((t) => ({ ...t, slug: realmSlug(t.region, t.server) }))
      .filter((t) => {
        const k = `${t.name}|${t.slug}`.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    if (rows.length >= 2) sections.push({ char: c, diff: d, rows });   // skip a lone left-over
  }
  if (!sections.length) return;
  // Header per group. One group -> the generic label. Several -> name the character;
  // and when a single character has more than one team, add the difficulty to tell them
  // apart (e.g. a Mythic group and a Heroic group on the same toon).
  const perChar = new Map();
  for (const s of sections) perChar.set(s.char.name, (perChar.get(s.char.name) || 0) + 1);
  for (const { char, diff, rows } of sections) {
    const h = document.createElement("div");
    h.className = "picker-h mates-h";
    h.textContent = sections.length === 1
      ? "Raid teammates — people you commonly raid with"
      : `Raid teammates — your ${char.name} group` +
        ((perChar.get(char.name) || 0) > 1 ? ` (${DIFFICULTY[diff]})` : "");
    picker.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "picker-grid";
    for (const m of rows) {
      grid.appendChild(charButton({
        name: m.name, server: m.slug, region: m.region, label: realmLabel(m.region, m.slug),
        extra: m.of ? `together in ${m.shared}/${m.of} recent raids` : `${m.shared} raids together`, cls: "charbtn mate",
      }));
    }
    picker.appendChild(grid);
  }
}

// A ?char=&region=&server= deep link prefills the form and, when it has enough
// to run (a shared result link), analyzes immediately -- overriding the picker.
// The analysis itself is cheap on reload because the fetches are cached (wcl.js).
async function deepLink() {
  const q = paramsFromSearch(location.search);
  if (!q.name) return false;
  await realmsReady;
  $("name").value = q.name;
  if (q.region) { regionSel.value = q.region; fillServers(); }
  if (q.server) serverSel.value = q.server;
  if (!(q.server && q.region)) return false;       // not enough to run
  if (isAuthed()) {
    form.style.display = "";
    const picker = $("picker"); if (picker) picker.style.display = "none";
    const serverLabel = serverSel.options[serverSel.selectedIndex]?.text || q.server;
    runAnalysis({ name: q.name, server: q.server, region: q.region, serverLabel });
    return true;
  }
  // Connect-only: can't run a shared link until connected. Remember it so the
  // connect prompt resumes it via OAuth returnState the moment they connect.
  pendingChar = { name: q.name, server: q.server, region: q.region };
  return false;
}

// Run a character carried back through the OAuth round-trip (returnState) or a
// deep link, prefilling the form for context behind the result.
function runResume(c) {
  form.style.display = "";
  const picker = $("picker"); if (picker) picker.style.display = "none";
  $("name").value = c.name;
  regionSel.value = c.region; fillServers(); serverSel.value = c.server;
  const serverLabel = serverSel.options[serverSel.selectedIndex]?.text || c.server;
  runAnalysis({ name: c.name, server: c.server, region: c.region, serverLabel });
}

// On load: finish any returning OAuth redirect, reflect auth state, then show
// the right mode (Connect prompt until connected; form + your-characters picker
// once connected) -- unless a deep link tells us exactly which character to run.
(async () => {
  let cb = null;
  try { cb = await handleRedirectCallback(); }
  catch (e) { showAuthErr(e); }
  renderAuth();
  // A #share= link is a read-only snapshot -- render it without needing an
  // account, and skip the connect/analyze flow entirely.
  if (await maybeRenderShared()) return;
  // Just connected via a shared/deep link? The character was stashed as
  // returnState (the OAuth redirect drops the ?char= query), so resume it.
  const resume = cb && cb.returnState;
  if (isAuthed() && resume && resume.name && resume.server && resume.region) {
    await realmsReady;
    runResume(resume);
    return;
  }
  if (progDeepLink()) return;          // ?report= link -> raid-progression flow
  // Restore the active tab from the URL (?mode=progression) so a reload / browser
  // back keeps you on the flow you were using.
  if (new URLSearchParams(location.search).get("mode") === "progression") mode = "progression";
  if (!(await deepLink())) renderMode();
})();

// --------------------------------------------------------------------------- //
// Rendering: cards instead of a terminal. Modules still emit text via log();
// here we turn that stream into headings, prose, data blocks, and action cards.
// --------------------------------------------------------------------------- //
// We deliberately do NOT follow output to the bottom as it streams: the old
// terminal-style auto-scroll is wrong now that the payoff ("What to change") sits
// at the TOP and the supporting cards (mostly collapsed) stream below -- it just
// dumped you at the bottom in empty space. We land on the primary card when the
// run finishes instead (see runAnalysis).
let cur = null; // fallback card for the global log()/note() (errors, validation)

// Every card has the SAME shape -- a header (title + a status indicator) and a
// body -- whether it's the primary list or a collapsible supporting analysis.
// Keeping one structure is what makes the cards look uniform.
// `prose`: render this card as wrapping sans prose + headings (the prescription),
// not the monospace column readout the data cards use. Defaults on for the
// primary card so both live runs and shared snapshots get it.
function makeCard(title, { primary = false, collapsed = false, prose = primary } = {}) {
  const el = document.createElement(collapsed ? "details" : "section");
  el.className = "card" + (primary ? " primary" : "") + (collapsed ? "" : " open");
  const head = document.createElement(collapsed ? "summary" : "div");
  head.className = "card-head";
  const ttl = document.createElement("span");
  ttl.className = "card-title";
  ttl.textContent = title;
  head.appendChild(ttl);
  el.appendChild(head);
  const body = document.createElement("div");
  body.className = "body";
  el.appendChild(body);
  out.appendChild(el);
  return { el, head, body, status: null, readout: null, prose };
}

// Per-card processing indicator. Each section shows its own state so that when
// they all run at once the page reads as several parallel flows.
function setCardState(h, state) {
  h.state = state;
  // The live last-line preview belongs to the "busy" phase only -- drop it the
  // moment the section finishes (or fails), leaving a clean collapsed header.
  if (state !== "busy" && h.preview) { h.preview.remove(); h.preview = null; }
  // "done" removes the indicator entirely -- the thinking spinner just vanishes.
  if (state === "done") { if (h.status) { h.status.remove(); h.status = null; } return; }
  if (!h.status) {
    h.status = document.createElement("span");
    h.status.className = "card-status";
    h.head.appendChild(h.status);
  }
  h.status.classList.toggle("err", state === "error");
  if (state === "error") h.status.textContent = "failed";  // keep failures legible
  else h.status.innerHTML = '<span class="spin"></span>';  // running: a thinking spinner
}

// While a collapsed section streams, show its latest line in the header so the
// wait reads as live progress, not a blank spinner. Cleared when it finishes.
function setPreview(h, text) {
  if (!(h.el && h.el.tagName === "DETAILS") || h.state !== "busy") return;
  if (!h.preview) {
    h.preview = document.createElement("span");
    h.preview.className = "card-preview";
    h.head.insertBefore(h.preview, h.status || null); // sits between title and spinner
  }
  h.preview.textContent = text;
}

// Rendering primitives, parameterized by the card handle `h` so sections running
// concurrently never write into one another's card.
function appendBlock(h, el) { h.body.appendChild(el); h.readout = null; }
// The card's single monospace readout (created lazily). Nulled whenever a block
// element (rx item / error) is appended, so the next data line starts a fresh
// readout AFTER it -- preserving stream order.
function readoutOf(h) {
  if (!h.readout) { h.readout = document.createElement("div"); h.readout.className = "readout"; h.body.appendChild(h.readout); }
  return h.readout;
}

// Tell Wowhead's tooltip widget (power.js) to (re)scan links as the report
// streams. Debounced because lines arrive one at a time.
let _whTimer = null;
function refreshWowhead() {
  clearTimeout(_whTimer);
  _whTimer = setTimeout(() => { try { window.$WowheadPower?.refreshLinks?.(); } catch (e) {} }, 250);
}
// Fill `el` with `text`, turning [label](https://…) links and **bold** markdown into
// safe DOM nodes (anchors / <strong>), never innerHTML. The parse lives in markup.js
// (pure + unit-tested); here we just build nodes from its tokens. (progression.js emits
// **bold** headlines; without this they render as literal asterisks.)
function fillText(el, text) {
  let linked = false;
  for (const t of tokenizeMarkup(text)) {
    if (t.type === "link") {
      const a = document.createElement("a");
      a.href = t.href || ""; a.target = "_blank"; a.rel = "noopener"; a.textContent = t.text;
      el.appendChild(a);
      linked = true;
    } else if (t.type === "bold") {
      const b = document.createElement("strong");
      b.textContent = t.text;
      el.appendChild(b);
    } else {
      el.appendChild(document.createTextNode(t.text));
    }
  }
  if (linked) refreshWowhead();
}

// One streamed text line -> a styled readout node. The analyses share a small
// vocabulary, mapped here to one visual language: section/subsection headers,
// "-> takeaway" callouts, a trailing "<-- annotation" lifted into a colored flag
// (red worse / green do-more), and otherwise an aligned data row.
function readoutLine(raw) {
  const trimmed = raw.trim();
  let m;
  if ((m = trimmed.match(/^={3,}\s*(.+?)\s*={3,}$/))) { const d = document.createElement("div"); d.className = "r-head"; d.textContent = m[1]; return d; }
  if ((m = trimmed.match(/^---\s*(.+?)\s*---$/)))     { const d = document.createElement("div"); d.className = "r-sub";  d.textContent = m[1]; return d; }
  const d = document.createElement("div");
  d.className = /^-?->/.test(trimmed) ? "r-call" : "r-line";
  let body = raw, flag = null;
  const fi = raw.indexOf("<--");
  if (fi >= 0) { flag = raw.slice(fi + 3).trim(); body = raw.slice(0, fi).replace(/\s+$/, ""); }
  fillText(d, body);
  if (flag) {
    const s = document.createElement("span");
    s.className = "r-flag " + (/(more|good|^ok\b|✓)/i.test(flag) ? "good" : "bad");
    s.textContent = "  ← " + flag;
    d.appendChild(s);
  }
  return d;
}

// A prose-card line (the prescription): `=== X ===` heading, `--- X ---` sub-
// heading, else a wrapping sans paragraph (indented if the source line was).
// No monospace readout -- this card is prose + action rows, never columns.
function proseLine(h, line) {
  const t = line.trim();
  if (t === "") return;
  let m;
  if ((m = t.match(/^={3,}\s*(.+?)\s*={3,}$/))) {
    const d = document.createElement("div"); d.className = "rx-h"; fillText(d, m[1]); return appendBlock(h, d);
  }
  if ((m = t.match(/^---\s*(.+?)\s*---$/))) {
    const d = document.createElement("div"); d.className = "rx-sub"; fillText(d, m[1]); return appendBlock(h, d);
  }
  const d = document.createElement("div");
  d.className = "note" + (/^\s/.test(line) ? " indent" : "");
  fillText(d, t); return appendBlock(h, d);
}

// A structured chart line (emitted by graph.js, prefixed CHART<json>) -> an inline
// SVG. Detected before everything else so the JSON payload never becomes a preview
// line or readout. Survives share snapshots: the snapshot stores the same line and
// replays it through logTo, redrawing the chart with no re-run.
const CHART_PREFIX = graph.CHART_PREFIX; // single source: graph.js owns + emits this marker

// Turn one streamed text line into the right DOM node inside card `h`.
function logTo(h, line) {
  if (line.startsWith(CHART_PREFIX)) {
    try { appendBlock(h, renderDpsChart(JSON.parse(line.slice(CHART_PREFIX.length)))); }
    catch (e) { /* malformed payload -> draw nothing */ }
    return;
  }
  // Live preview: mirror the latest meaningful line into the collapsed header
  // (links -> plain text, separators stripped) so loading shows real progress.
  if (h.state === "busy") {
    const t = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[=#–—-]{2,}/g, " ").replace(/\s+/g, " ").trim();
    if (t) setPreview(h, t);
  }
  if (/^[=#-]{3,}$/.test(line.trim())) return;                  // bare separator bars
  const m = line.match(/^\s*(\d+)\.\s*\[\s*(.+?)\s*\]\s*(.+)$/); // prescription item -> its own card
  if (m) {
    const info = /info/i.test(m[2]);
    const d = document.createElement("div"); d.className = "rx" + (info ? " info" : "");
    const n = document.createElement("div"); n.className = "num"; n.textContent = m[1];
    const b = document.createElement("div"); b.className = "badge"; b.textContent = m[2].replace(/\s+/g, " ");
    const t = document.createElement("div"); t.className = "txt"; fillText(t, m[3]);
    d.append(n, b, t); return appendBlock(h, d);
  }
  if (/^\[error]/.test(line)) {
    const d = document.createElement("div"); d.className = "note err";
    fillText(d, line.replace(/^\[error]\s*/, "")); return appendBlock(h, d);
  }
  if (h.prose) return proseLine(h, line);                       // prescription: sans prose, not columns
  if (line.trim() === "") {                                     // blank -> a gap in the readout
    if (h.readout) { const g = document.createElement("div"); g.className = "r-gap"; h.readout.appendChild(g); }
    return;
  }
  readoutOf(h).appendChild(readoutLine(line));
}

// A logger bound to one card -- this is what each section streams into.
const makeLog = (h) => (line) => logTo(h, line);
// Like makeLog, but also RECORDS each line into `lines` so the finished report
// can be re-rendered from a share link (no re-run).
const recLog = (h, lines) => (line) => { lines.push(line); logTo(h, line); };

// Globals for the non-section paths (auth/validation errors, the placeholder
// line): they target the current fallback card `cur`.
function note(text, cls = "") {
  if (!cur) cur = makeCard("Results");
  const d = document.createElement("div"); d.className = "note " + cls;
  fillText(d, text); return appendBlock(cur, d);
}

function setRunning(on) {
  goBtn.disabled = on;
  goBtn.textContent = on ? "Analyzing…" : "Analyze";
  statusEl.innerHTML = on ? '<span class="spin"></span>analyzing…' : "";
}

// Surface WCL rate-limit waits so the page never just looks frozen -- with a
// reset ETA when WCL provides one (Retry-After).
let activeHero = null;
window.addEventListener("wcl-ratelimit", (e) => {
  const detail = /** @type {CustomEvent} */ (e).detail;
  const wait = fmtRateWait(detail && detail.retryAfter);   // same formatter as the thrown error
  // "Auto-retrying" makes clear this is the WAITING state -- distinct from the
  // final "Try again in ~X" error you see only if the retries give up.
  const when = wait ? ` — auto-retrying, budget resets in ~${wait}` : " — auto-retrying";
  if (activeHero && activeHero.det && activeHero.det.isConnected) {
    activeHero.det.textContent = `WCL rate limit reached${when}…`;
  }
  // Keep the inline (next-to-button) status short so it doesn't wrap onto its own
  // line; the ETA detail lives in the hero line, which has room.
  statusEl.innerHTML = '<span class="spin"></span>rate limited…';
});

// Supporting analyses (collapsed by default -- evidence behind the list).
/** @type {[string, (p: any, log: (line?: string) => void) => any][]} */
const SUPPORTING = [
  ["Overview", (p, log) => overview.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Timeline", (p, log) => timeline.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Damage curve", (p, log) => graph.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Rotation", (p, log) => rotation.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Talents", (p, log) => talents.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Top parses", (p, log) => topparse.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
  ["Gear", (p, log) => gear.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty, p.priority)],
  ["Consumables", (p, log) => consumables.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)],
];

// The supporting cards for this run. Healers get a "Healing efficiency" card
// (overhealing + mana -- the levers they actually control, since raw HPS is
// damage-bound); damage specs don't. Built AFTER detection so we know the role.
function supportingFor(isHealerRun, isSupportRun) {
  if (!isHealerRun && !isSupportRun) return SUPPORTING;
  const list = SUPPORTING.slice();
  /** @type {[string, (p:any, log:(line?:string)=>void)=>any]} */
  const extraCard = isHealerRun
    ? ["Healing",
       (p, log) => healing.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)]
    : ["Support",
       (p, log) => support.run(log, p.name, p.server, p.region, p.cls, p.spec, p.difficulty)];
  const after = list.findIndex(([t]) => /^Rotation/.test(t));   // sits next to rotation
  list.splice(after >= 0 ? after + 1 : list.length, 0, extraCard);
  return list;
}

function buildHero(name, server, region) {
  const h = document.createElement("section"); h.className = "hero";
  const who = document.createElement("div"); who.className = "who";
  who.textContent = name + " ";
  const small = document.createElement("small"); small.textContent = `${server} · ${region}`;
  who.appendChild(small);
  const det = document.createElement("div"); det.className = "detecting";
  det.textContent = "Detecting class, spec, and difficulty…";
  const pills = document.createElement("div"); pills.className = "pills";
  h.append(who, det, pills); out.appendChild(h);
  return { det, pills };
}
function setPills(hero, items) {
  hero.det.remove();
  for (const [text, muted, tip] of items) {
    const s = document.createElement("span"); s.className = "pill" + (muted ? " muted" : "");
    s.textContent = text;
    if (tip) { s.title = tip; s.classList.add("has-tip"); } // native hover tooltip (e.g. what "DPS" means)
    hero.pills.appendChild(s);
  }
}

// The finished report, captured for sharing (set when a run completes; null while
// running or on a fresh page). Encoded into the link on demand.
let lastSnapshot = null;

// A back link at the top of the report returns to the search form + your-
// characters picker (whatever renderMode() shows when connected).
function addBackBar() {
  const bar = document.createElement("div");
  bar.id = "backbar";
  bar.className = "backbar";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "linkbtn back";
  b.textContent = !isAuthed() ? "← New search" : (mode === "progression" ? "← Raid reports" : "← Your characters");
  b.onclick = goBack;
  bar.appendChild(b);
  out.appendChild(bar); // first child of the freshly-cleared #out -> sits on top
}

// Add a "Copy share link" button to the back bar once a report finishes. The
// link carries the rendered result in the URL fragment, so a friend opens it
// with no login and no Warcraft Logs calls.
function addShareButton() {
  const bar = document.getElementById("backbar");
  if (!bar || !lastSnapshot || bar.querySelector(".share")) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "linkbtn share";
  b.textContent = "🔗 Copy share link";
  b.onclick = async () => {
    try {
      const enc = await encodeSnapshot(lastSnapshot);
      const url = location.origin + location.pathname + "#share=" + enc;
      try { await navigator.clipboard.writeText(url); b.textContent = "✓ Link copied"; }
      catch (e) { history.replaceState(null, "", url); b.textContent = "✓ Link in address bar"; }
      setTimeout(() => { b.textContent = "🔗 Copy share link"; }, 2500);
    } catch (e) { b.textContent = "Couldn't build link"; }
  };
  bar.appendChild(b);
}

// Render a shared report (decoded from #share=) statically -- no auth, no WCL.
// This is what a friend who isn't logged in sees.
function renderSnapshot(snap) {
  const introEl = document.getElementById("intro");
  if (introEl) introEl.style.display = "none";
  form.style.display = "none";
  const picker = $("picker"); if (picker) picker.style.display = "none";
  out.innerHTML = ""; cur = null;
  // Back/own-analysis bar.
  const bar = document.createElement("div"); bar.className = "backbar"; out.appendChild(bar);
  const note0 = document.createElement("span"); note0.className = "shared-note";
  note0.textContent = "Shared analysis (read-only)";
  bar.appendChild(note0);
  const mine = document.createElement("button");
  mine.type = "button"; mine.className = "linkbtn back";
  mine.textContent = "Analyze your own →";
  mine.onclick = () => { try { history.replaceState(null, "", location.pathname); } catch (e) {} location.reload(); };
  bar.appendChild(mine);
  // Hero + pills, then every section replayed from its captured lines.
  const hero = buildHero(snap.name, snap.serverLabel || snap.region, snap.region);
  setPills(hero, snap.pills || []);
  for (const s of (snap.sections || [])) {
    const card = makeCard(s.title, { primary: !!s.primary, collapsed: !s.primary });
    for (const line of (s.lines || [])) logTo(card, line);
  }
  window.scrollTo(0, 0);
}

// If the URL carries a #share= snapshot, render it and return true (skip the
// normal connect/analyze flow -- a shared link must work without an account).
async function maybeRenderShared() {
  const raw = snapshotFromHash(location.hash);
  if (!raw) return false;
  const snap = await decodeSnapshot(raw);
  if (!snap || !snap.sections) return false;
  renderSnapshot(snap);
  return true;
}
function goBack() {
  setRunning(false);
  stopPolling();             // stop any live progression refresh
  activeHero = null;
  out.innerHTML = ""; cur = null;
  // Drop the per-run deep-link params (so a reload doesn't re-run the analysis) but
  // KEEP the active tab so back lands you on the flow you were using.
  syncModeUrl();
  renderMode();              // re-shows the active tab's form + picker (or Connect prompt)
  window.scrollTo(0, 0);
}

// Run the full analysis for one character. Called by the search form (any
// character) and by clicking one of your own characters in the picker.
async function runAnalysis({ name, server, region, serverLabel }) {
  // Keep the address bar in sync so the result is bookmarkable / shareable.
  try { history.replaceState(null, "", location.pathname + shareSearch({ name, region, server })); } catch (e) { /* ignore */ }
  primeRateReset(); // connected: learn the reset clock now, while still under budget
  out.innerHTML = ""; cur = null;
  setRunning(true);
  // Hide the search form / character list and the intro so the report has the
  // page to itself; the back link (added next) brings the list back.
  form.style.display = "none";
  const picker = $("picker"); if (picker) picker.style.display = "none";
  const intro = document.getElementById("intro");
  if (intro) intro.style.display = "none";
  addBackBar();
  window.scrollTo(0, 0);   // start the report at the top (hero + the primary card)
  const hero = buildHero(name, serverLabel || server, region);
  activeHero = hero;
  // Build the whole report up front so every card appears at once, each already
  // showing a thinking spinner. The primary list sits on top (filled last, off
  // the warm cache); the supporting analyses are created right after it.
  // Record every streamed line so the finished report can be shared (see
  // buildSnapshot / addShareButton) -- a friend opens the link with no login.
  const snap = { v: 1, name, serverLabel: serverLabel || server, region,
    pills: /** @type {[string, boolean, string?][]} */ ([]), sections: /** @type {any[]} */ ([]) };
  const rxCard = makeCard("What to change", { primary: true });
  setCardState(rxCard, "busy");
  cur = rxCard; note("Crunching your kills and your peers…", "muted");
  const rxLines = [];
  // Built once the role is known (after detection) so the card set is role-aware;
  // declared here so the catch below can clear any still-spinning cards.
  let sections = SUPPORTING, supRecs = [];

  try {
    const ctx = await detectContext(name, server, region);
    // Healers are measured on HEALING, everyone else on DAMAGE -- set before
    // detectPriority so the stat sample is drawn from the right-metric peers.
    setRunContext(ctx.className, ctx.specName); // metric (HPS for healers) + support framing, atomically
    // The supporting card set is role-aware (healers get a Healing efficiency
    // card, support specs a Support buffs card), so it's built here -- once the
    // run metric/role is known.
    sections = supportingFor(metricForSpec(ctx.className, ctx.specName) === "hps", isSupport(ctx.specName));
    supRecs = sections.map(([title]) => {
      const card = makeCard(title, { collapsed: true });
      setCardState(card, "busy");
      return { card, title, lines: [] };
    });
    const priority = await detectPriority(ctx.className, ctx.specName, ctx.difficulty, ctx.killed[0].encounter.id);
    const metricTip = runIsHealer()
      ? "Measured on HPS (healing per second) — this is a healing spec, so every recommendation's % is a share of your healing."
      : "Measured on DPS (damage per second) — every recommendation's % is a share of your damage. Healers are graded on HPS instead.";
    snap.pills = [
      [`${ctx.specName} ${ctx.className}`, false, "Class and spec detected from your most recent kill."],
      [DIFFICULTY[ctx.difficulty], true, "The raid difficulty of the kill being analyzed — percentiles only compare within a difficulty."],
      [`${priority.charAt(0).toUpperCase() + priority.slice(1)} priority`, true, `Your highest-value secondary stat (${priority}), derived from the field — it drives the gear and gem advice.`],
      [`${metricUnit()}`, true, metricTip],
    ];
    setPills(hero, snap.pills);
    const p = { name, server, region, cls: ctx.className, spec: ctx.specName, difficulty: ctx.difficulty, priority };

    // The supporting analyses all start at the SAME time, each streaming into
    // its own card; the card's spinner disappears the moment it finishes. (gql()
    // coalesces/caches identical queries, so concurrent sections share
    // overlapping requests rather than multiplying the API load.)
    const settled = await Promise.allSettled(sections.map(([, runFn], i) => {
      const { card, lines } = supRecs[i];
      return Promise.resolve(runFn(p, recLog(card, lines))).then(
        () => setCardState(card, "done"),
        (err) => {
          setCardState(card, "error");
          if (err instanceof NeedsAuth) throw err; // bubble up to the reconnect flow
          const d = document.createElement("div"); d.className = "note err";
          fillText(d, `${err.message || err}`); appendBlock(card, d);
        },
      );
    }));
    const reconnect = /** @type {PromiseRejectedResult | undefined} */ (
      settled.find((s) => s.status === "rejected" && /** @type {PromiseRejectedResult} */ (s).reason instanceof NeedsAuth));
    if (reconnect) throw reconnect.reason;

    // The prioritized list depends on the analyses above (cache now warm), so it
    // fills last -- the payoff once the supporting flows complete.
    rxCard.body.innerHTML = ""; cur = rxCard; // clear placeholder, fill the list
    try {
      await prescribe.run(recLog(rxCard, rxLines), p.name, p.server, p.region, p.cls, p.spec, p.difficulty, p.priority);
      setCardState(rxCard, "done");
      // Land on the payoff: bring "What to change" into view (it filled last, and
      // the user may have scrolled through the supporting cards while waiting).
      try { rxCard.el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) { /* ignore */ }
    } catch (err) {
      setCardState(rxCard, "error");
      if (err instanceof NeedsAuth) throw err;
      note(`${err.message || err}`, "err");
    }

    // Report is complete -- assemble the shareable snapshot and offer the link.
    snap.sections = [{ title: "What to change", primary: true, lines: rxLines },
      ...supRecs.map((r) => ({ title: r.title, lines: r.lines }))];
    lastSnapshot = snap;
    addShareButton();
    statusEl.textContent = "Done.";

  } catch (err) {
    // Sections that never got to run (e.g. detection failed) shouldn't keep
    // spinning -- remove the ones still pending.
    supRecs.forEach((r) => { if (r.card.state === "busy") r.card.el.remove(); });
    setCardState(rxCard, "error");
    rxCard.body.innerHTML = ""; cur = rxCard;
    if (err instanceof NeedsAuth) {
      logout(); renderAuth(); renderMode();
      note(err.message || "Reconnect to Warcraft Logs to continue.", "err");
    } else {
      note(err.message || String(err), "err");
    }
  } finally {
    setRunning(false);
  }
}

// --------------------------------------------------------------------------- //
// Raid PROGRESSION flow: analyze a report's pulls and stream the group's "what to
// change to kill the boss" list. Auto-reloads live as new pulls land.
// --------------------------------------------------------------------------- //
const fmtDate = (ms) => { try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; } };

// Recent raid nights as quick-picks (best-effort), plus the paste-a-URL form.
// Merges reports across ALL your characters (so an alt's raid night shows up too),
// deduped by report code, newest first -- a much fuller list than one character's.
// Give MANY choices from FEW queries: one character's recentReports already
// returns dozens of nights, so we scan just the 1-2 most-active characters (each
// query is cached for a week) rather than fanning out across the roster and
// bursting the hourly point budget into a 429.
const PROG_PICKER_CHARS = 2;        // characters to scan for raid nights (bounded for quota)
const PROG_REPORTS_PER_CHAR = 40;   // plenty of nights from each; dedup + cap below
const PROG_REPORTS_SHOWN = 40;      // how many distinct nights to list
async function renderProgPicker() {
  if (!progPicker) return;
  const run = ++pickerRun;
  progPicker.style.display = "";
  progPicker.innerHTML = "";
  const h = document.createElement("div");
  h.className = "picker-h";
  h.textContent = "Recent raid nights — or paste any report URL above";
  progPicker.appendChild(h);
  let chars = [];
  try { chars = await myCharacters(); } catch { chars = []; }
  if (run !== pickerRun) return;
  // Gather across a few of your characters, but BOUND the concurrency (mapLimit) so
  // we never burst the hourly point budget into a 429. recentReportsFor is a
  // character query -> cached for a week, so this cost is first-load-only.
  const lists = await mapLimit(chars.slice(0, PROG_PICKER_CHARS), 3, (c) =>
    recentReportsFor(c.name, c.server, c.region, PROG_REPORTS_PER_CHAR).catch(() => []));
  if (run !== pickerRun) return;
  const byCode = new Map();
  for (const list of (lists || [])) for (const rp of (list || [])) if (rp && rp.code && !byCode.has(rp.code)) byCode.set(rp.code, rp);
  const reps = [...byCode.values()].sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, PROG_REPORTS_SHOWN);
  if (!reps.length) {
    const m = document.createElement("div"); m.className = "muted";
    m.textContent = chars.length
      ? "Couldn't load your recent reports right now (you may be briefly rate-limited) — paste a report URL above to analyze a night of pulls."
      : "Paste a Warcraft Logs report URL above to analyze a night of pulls.";
    progPicker.appendChild(m); return;
  }
  const grid = document.createElement("div");
  grid.className = "picker-grid";
  for (const rp of reps) {
    const b = document.createElement("button"); b.type = "button"; b.className = "charbtn";
    const cn = document.createElement("span"); cn.className = "cn"; cn.textContent = (rp.zone && rp.zone.name) || rp.title || "Raid night";
    const cs = document.createElement("span"); cs.className = "cs";
    cs.textContent = [fmtDate(rp.startTime), rp.title].filter(Boolean).join(" · ");
    b.append(cn, cs);
    b.onclick = () => runProgression({ code: rp.code, live: false });
    grid.appendChild(b);
  }
  progPicker.appendChild(grid);
}

// A progression-specific hero: report link + a status line (boss/pulls/wall) and a
// row for the encounter chooser and the live indicator.
function buildProgHero(code) {
  const h = document.createElement("section"); h.className = "hero";
  const who = document.createElement("div"); who.className = "who";
  who.textContent = "Raid progression ";
  const small = document.createElement("small");
  const a = document.createElement("a");
  a.href = `https://www.warcraftlogs.com/reports/${code}`; a.target = "_blank"; a.rel = "noopener";
  a.textContent = `report ${code}`;
  small.appendChild(a); who.appendChild(small);
  const det = document.createElement("div"); det.className = "detecting";
  det.textContent = "Reading pulls…";
  const encbar = document.createElement("div"); encbar.className = "encbar";
  h.append(who, det, encbar); out.appendChild(h);
  return {
    el: h, det, encbar,
    setStatus(r) {
      if (!r) { det.textContent = ""; return; }
      const wall = r.wall ? ` · wall ~${r.wall.rem}% left${r.multiPhase ? ` (P${r.wall.phase})` : ""}` : "";
      const best = r.deepest ? ` · best ${Math.round(r.bestRemaining)}% left` : (r.killed ? " · KILLED ✓" : "");
      det.textContent = `${DIFFICULTY[r.difficulty] || ""} ${r.boss} · ${r.nPulls} pulls${best}${wall}`.trim();
    },
  };
}

// The encounter chooser chips (when a report has more than one boss) + the live dot.
function buildEncBar(hero, encs, chosen, live) {
  hero.encbar.innerHTML = "";
  if (encs.length > 1) {
    const lbl = document.createElement("span"); lbl.className = "enclabel"; lbl.textContent = "Boss:";
    hero.encbar.appendChild(lbl);
    for (const e of encs) {
      const c = document.createElement("button"); c.type = "button";
      c.className = "encchip" + (e.encounterID === chosen ? " active" : "");
      const tag = e.kills ? `${e.wipes}w · ${e.kills}k` : `${e.pulls} pulls`;
      c.textContent = `${e.name} (${tag})`;
      c.onclick = () => { if (e.encounterID !== progCtx.encounterId) { progCtx.encounterId = e.encounterID; renderProgFull(); } };
      hero.encbar.appendChild(c);
    }
  }
  if (live) {
    const lf = document.createElement("span"); lf.className = "liveflag";
    const dot = document.createElement("span"); dot.className = "dot";
    lf.append(dot, document.createTextNode(`Live — checks for new pulls every ${PROG_POLL_MS / 1000}s`));
    hero.encbar.appendChild(lf);
  }
}

// Live polling is the ONLY part of this flow that spends quota repeatedly, so it's
// deliberately frugal: one cheap reportFights({fresh}) per tick, and if the fight
// list is unchanged we do NOTHING else (no re-analysis, no re-render). We also pause
// entirely while the tab is hidden. Everything else (a finished report's pulls,
// deaths, tables) is immutable and cached forever, so a non-live run re-spends zero.
const PROG_POLL_MS = 60000;
let progCtx = null;       // { code, encounterId, live }
let progPoll = null;      // pending setTimeout for the next live check
let progLiveOn = false;
let progSig = null;       // signature of the last-rendered fight list (skip no-op re-renders)
let progVisListener = null;

// ids + endTimes + kill flags: changes EXACTLY when a pull is added or one ends.
const fightsSignature = (fights) => (fights || []).map((f) => `${f.id}:${f.endTime || 0}:${f.kill ? 1 : 0}`).join(",");

function stopPolling() {
  if (progPoll) { clearTimeout(progPoll); progPoll = null; }
  progLiveOn = false;
  if (progVisListener) { document.removeEventListener("visibilitychange", progVisListener); progVisListener = null; }
}
function scheduleProgPoll() { if (progLiveOn) { if (progPoll) clearTimeout(progPoll); progPoll = setTimeout(pollProg, PROG_POLL_MS); } }

// One live tick: a single fresh fight-list fetch. Re-analyze only if a pull was
// added/ended; otherwise just wait. Skip the fetch entirely while the tab's hidden.
async function pollProg() {
  progPoll = null;
  if (!progLiveOn) return;
  if (typeof document !== "undefined" && document.hidden) {
    if (!progVisListener) {
      progVisListener = () => {
        if (!document.hidden && progLiveOn) { document.removeEventListener("visibilitychange", progVisListener); progVisListener = null; pollProg(); }
      };
      document.addEventListener("visibilitychange", progVisListener);
    }
    return; // paused: no quota spent while you're not looking
  }
  let fights = [];
  try { fights = await reportFights(progCtx.code, { fresh: true }); }  // the ONE fresh request per tick
  catch { return scheduleProgPoll(); }                                  // transient -> retry next tick
  if (!progLiveOn) return;
  if (fightsSignature(fights) === progSig) return scheduleProgPoll();   // nothing new -> no re-fetch, no re-render
  await renderProgFull();                                               // a pull changed -> re-analyze (downstream cached)
}

// One render pass: build the chooser + stream the analysis into the primary card.
// reportFights is read fresh:false here -- the caller (runProgression / pollProg)
// already primed the cache with a single fresh fetch when live, so this adds no
// network. Ended pulls' deaths/tables are immutable and cached. Returns the result.
async function renderProgOnce(hero) {
  const { code, encounterId } = progCtx;
  let fights = [];
  try { fights = await reportFights(code, { fresh: false }); } catch (e) { /* analysis will surface the error */ }
  progSig = fightsSignature(fights);
  const encs = progression.encountersIn(fights);
  const chosen = encounterId || (encs[0] && encs[0].encounterID) || null;
  buildEncBar(hero, encs, chosen, progLiveOn);
  const card = makeCard("What to change to kill it", { primary: true, prose: false });
  setCardState(card, "busy"); cur = card;
  try {
    const r = await progression.run(makeLog(card), { code }, { encounterId: chosen, fresh: progLiveOn });
    setCardState(card, "done");
    hero.setStatus(r);
    return r;
  } catch (err) {
    setCardState(card, "error");
    if (err instanceof NeedsAuth) throw err;
    note(`${err.message || err}`, "err");
    return null;
  }
}

// Full (re)render of the progression report -- also the live-poll re-render body.
async function renderProgFull() {
  if (progPoll) { clearTimeout(progPoll); progPoll = null; }
  out.innerHTML = ""; cur = null;
  addBackBar();
  window.scrollTo(0, 0);
  const hero = buildProgHero(progCtx.code); activeHero = hero;
  progBusy(true);
  let r = null;
  try { r = await renderProgOnce(hero); }
  catch (err) {
    if (err instanceof NeedsAuth) {
      stopPolling(); logout(); renderAuth();
      note(err.message || "Reconnect to Warcraft Logs to continue.", "err");
      progBusy(false); return;
    }
  }
  progBusy(false);
  statusEl.textContent = "Done.";
  // Live: stop on the kill (the win); otherwise schedule the next frugal check.
  if (progLiveOn && r && r.killed) { stopPolling(); hero.det.textContent += " — killed, live updates stopped ✓"; return; }
  scheduleProgPoll();
}
function progBusy(on) {
  const gp = $("goprog"), ps = $("progstatus");
  if (gp) { gp.disabled = on; gp.textContent = on ? "Analyzing…" : "Analyze pulls"; }
  if (ps) ps.innerHTML = on ? '<span class="spin"></span>analyzing…' : "";
}

// Entry: run the progression analyzer for a report (from the form, a quick-pick,
// or a deep link). `live` starts the auto-reload poll.
/** @param {{code:string, encounterId?:number|null, live?:boolean}} opts */
async function runProgression({ code, encounterId = null, live = false }) {
  if (!code) return;
  stopPolling();
  progLiveOn = live;
  progCtx = { code, encounterId, live }; progSig = null;
  try { history.replaceState(null, "", location.pathname + `?report=${encodeURIComponent(code)}` + (encounterId ? `&enc=${encounterId}` : "") + (live ? "&live=1" : "")); } catch (e) { /* ignore */ }
  primeRateReset();
  if (modebar) modebar.style.display = "none";
  if (progForm) progForm.style.display = "none";
  if (progPicker) progPicker.style.display = "none";
  const intro = document.getElementById("intro"); if (intro) intro.style.display = "none";
  // Live: prime the fight list with the ONE fresh fetch so the in-progress report
  // isn't served from the permanent cache; non-live reads the (immutable) cache.
  if (live) { try { await reportFights(code, { fresh: true }); } catch (e) { /* renderProgOnce surfaces it */ } }
  await renderProgFull();
}

// ?report=CODE[&enc=ID][&live=1] deep link -> run the progression flow.
function progDeepLink() {
  const p = new URLSearchParams(location.search);
  const raw = (p.get("report") || "").trim();
  if (!raw) return false;
  mode = "progression";
  const { code } = parseReportRef(raw);
  if (!code) return false;
  if (!isAuthed()) return false;   // can't run until connected; the prompt resumes the mode
  const enc = parseInt(p.get("enc") || "", 10);
  runProgression({ code, encounterId: Number.isFinite(enc) ? enc : null, live: p.get("live") === "1" });
  return true;
}

if (progForm) progForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const { code } = parseReportRef(($("report").value || "").trim());
  const live = !!($("live") && $("live").checked);
  if (!code) { out.innerHTML = ""; cur = makeCard("Error"); note("Paste a Warcraft Logs report URL or code.", "err"); return; }
  runProgression({ code, live });
});

// Search form: analyze ANY character once connected (yours or a friend's).
// Shown only when connected; the Connect prompt replaces it otherwise.
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  const region = regionSel.value;
  const server = serverSel.value;
  const serverLabel = serverSel.options[serverSel.selectedIndex]?.text || server;
  const fail = (msg) => { out.innerHTML = ""; cur = makeCard("Error"); note(msg, "err"); };
  if (!name) return fail("Enter a character name.");
  if (!server) return fail("Pick a server.");
  runAnalysis({ name, server, region, serverLabel });
});
